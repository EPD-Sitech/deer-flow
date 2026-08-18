import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.gateway.authz import (
    _AuthorizationUnavailable,
    _is_internal_caller,
    resolve_model_authorization,
)
from app.gateway.deps import get_config, get_optional_user_from_request
from deerflow.authz.provider import AuthzDecision, AuthzRequest
from deerflow.config.app_config import AppConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["models"])


class ModelResponse(BaseModel):
    """Response model for model information."""

    name: str = Field(..., description="Unique identifier for the model")
    model: str = Field(..., description="Actual provider model identifier")
    display_name: str | None = Field(None, description="Human-readable name")
    description: str | None = Field(None, description="Model description")
    supports_thinking: bool = Field(default=False, description="Whether model supports thinking mode")
    supports_reasoning_effort: bool = Field(default=False, description="Whether model supports reasoning effort")


class TokenUsageResponse(BaseModel):
    """Token usage display configuration."""

    enabled: bool = Field(default=False, description="Whether token usage display is enabled")


class ModelsListResponse(BaseModel):
    """Response model for listing all models."""

    models: list[ModelResponse]
    token_usage: TokenUsageResponse
    # Transit (Yixin SSO) metadata — optional so existing consumers are unaffected.
    is_yixin_user: bool = Field(default=False, description="True when the session carries a Yixin onconUUID claim")
    has_api_key: bool = Field(default=False, description="True when the user's oneai apiKey was resolved live from YiXin (never stored)")
    default_model: str | None = Field(default=None, description="The user's last selected model (null until first selection)")


async def _resolve_transit_model(request: Request, model_name: str) -> ModelResponse | None:
    """Resolve a model against the caller's oneai relay catalog, or None."""
    try:
        from app.gateway.transit.service import (
            fetch_transit_models,
            get_yx_uuid_from_request,
        )

        yx_uuid = get_yx_uuid_from_request(request)
        if not yx_uuid:
            return None
        fetched = await fetch_transit_models(yx_uuid)
        for item in fetched:
            if item.get("name") == model_name:
                return ModelResponse(
                    name=item["name"],
                    model=item["name"],
                    display_name=item.get("display_name") or item["name"],
                    description=None,
                )
    except Exception:  # noqa: BLE001 - degrade: treat as unknown model
        logger.warning("Failed to resolve transit model %s", model_name, exc_info=True)
    return None


@router.get(
    "/models",
    response_model=ModelsListResponse,
    summary="List All Models",
    description="Retrieve a list of all available AI models configured in the system.",
)
async def list_models(
    request: Request,
    config: AppConfig = Depends(get_config),
) -> ModelsListResponse:
    """List all available models from configuration.

    Returns model information suitable for frontend display,
    excluding sensitive fields like API keys and internal configuration.

    When ``authorization.enabled`` is true, only models the caller's role may
    ``list`` are returned (filtered via ``provider.filter_resources``). A
    provider error yields an empty list (fail-closed) or all models (fail-open).

    Returns:
        A list of all configured models with their metadata and token usage display settings.

    Example Response:
        ```json
        {
            "models": [
                {
                    "name": "gpt-4",
                    "model": "gpt-4",
                    "display_name": "GPT-4",
                    "description": "OpenAI GPT-4 model",
                    "supports_thinking": false,
                    "supports_reasoning_effort": false
                },
                {
                    "name": "claude-3-opus",
                    "model": "claude-3-opus",
                    "display_name": "Claude 3 Opus",
                    "description": "Anthropic Claude 3 Opus model",
                    "supports_thinking": true,
                    "supports_reasoning_effort": false
                }
            ],
            "token_usage": {
                "enabled": true
            }
        }
        ```
    """
    visible_models = config.models
    fail_closed = config.authorization.fail_closed

    user = await get_optional_user_from_request(request)
    if user is not None:
        try:
            provider, principal = resolve_model_authorization(user, is_internal=_is_internal_caller(request, user))
        except _AuthorizationUnavailable as exc:
            if exc.fail_closed:
                visible_models = []
        else:
            if provider is not None and principal is not None:
                try:
                    allowed_names = provider.filter_resources(principal, "model", [m.name for m in config.models])
                    if not isinstance(allowed_names, list) or any(not isinstance(n, str) for n in allowed_names):
                        raise TypeError("AuthorizationProvider.filter_resources must return list[str]")
                    allowed_set = set(allowed_names)
                    visible_models = [m for m in config.models if m.name in allowed_set]
                except Exception:
                    logger.warning("Authorization provider failed while filtering models", exc_info=True)
                    visible_models = [] if fail_closed else config.models

    # Transit (Yixin SSO) users get their oneai models instead of the static
    # catalog. The relay model list is a global shared resource; only the user's
    # apiKey differs. The apiKey is fetched live from YiXin (never persisted);
    # on failure fall back to the static catalog and report has_api_key=False so
    # the frontend can show an error + retry via POST /api/models/refresh.
    is_yixin_user = False
    transit_has_key = False
    transit_default_model = None
    transit_models: list[ModelResponse] = []
    if user is not None:
        try:
            from app.gateway.transit.service import (
                fetch_transit_models,
                get_transit_default_model,
                get_yx_uuid_from_request,
            )

            yx_uuid = get_yx_uuid_from_request(request)
            is_yixin_user = bool(yx_uuid)
            if yx_uuid:
                transit_default_model = get_transit_default_model(str(user.id))
                try:
                    fetched = await fetch_transit_models(yx_uuid)
                    transit_models = [
                        ModelResponse(
                            name=item["name"],
                            model=item["name"],
                            display_name=item.get("display_name") or item["name"],
                            description=None,
                        )
                        for item in fetched
                    ]
                    transit_has_key = True
                except HTTPException:
                    logger.warning("Failed to fetch oneai models for user %s", user.id, exc_info=True)
        except Exception:  # noqa: BLE001 - transit must never break the static model list
            logger.warning("Transit credential resolution failed for user %s", user.id, exc_info=True)

    if is_yixin_user and transit_has_key:
        models = transit_models
    else:
        models = [
            ModelResponse(
                name=model.name,
                model=model.model,
                display_name=model.display_name,
                description=model.description,
                supports_thinking=model.supports_thinking,
                supports_reasoning_effort=model.supports_reasoning_effort,
            )
            for model in visible_models
        ]
    return ModelsListResponse(
        models=models,
        token_usage=TokenUsageResponse(enabled=config.token_usage.enabled),
        is_yixin_user=is_yixin_user,
        has_api_key=transit_has_key,
        default_model=transit_default_model,
    )


@router.get(
    "/models/{model_name}",
    response_model=ModelResponse,
    summary="Get Model Details",
    description="Retrieve detailed information about a specific AI model by its name.",
)
async def get_model(
    model_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> ModelResponse:
    """Get a specific model by name.

    Args:
        model_name: The unique name of the model to retrieve.

    Returns:
        Model information if found.

    Raises:
        HTTPException: 404 if model not found; 403 if the caller's role may not
        ``use`` the model (only when ``authorization.enabled`` is true). A
        provider resolution error yields 403 (fail-closed) or allows the request
        (fail-open), mirroring ``list_models``'s provider-error semantics.

    Example Response:
        ```json
        {
            "name": "gpt-4",
            "display_name": "GPT-4",
            "description": "OpenAI GPT-4 model",
            "supports_thinking": false
        }
        ```
    """
    model = config.get_model_config(model_name)
    if model is None:
        # Transit (Yixin SSO) users may request a relay model not in the static
        # catalog. Resolve against their oneai catalog so /models/{name} works
        # for the frontend's selected model.
        model = await _resolve_transit_model(request, model_name)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found")

    # Phase 3: enforce model:use authorization (deny → 403, not 404, since the
    # model exists but the role lacks permission to use it).
    fail_closed = config.authorization.fail_closed
    user = await get_optional_user_from_request(request)
    if user is not None:
        try:
            provider, principal = resolve_model_authorization(user, is_internal=_is_internal_caller(request, user))
        except _AuthorizationUnavailable:
            if fail_closed:
                raise HTTPException(status_code=403, detail=f"Model '{model_name}' is not available for your role")
        else:
            if provider is not None and principal is not None:
                try:
                    decision = provider.authorize(AuthzRequest(principal=principal, resource="model", action="use", target=model_name))
                    if not isinstance(decision, AuthzDecision):
                        raise TypeError("AuthorizationProvider.authorize must return AuthzDecision")
                    allowed = decision.allow
                except Exception:
                    logger.warning(
                        "Authorization provider failed while checking model:use for %s",
                        model_name,
                        exc_info=True,
                    )
                    allowed = not fail_closed
                if not allowed:
                    raise HTTPException(status_code=403, detail=f"Model '{model_name}' is not available for your role")

    return ModelResponse(
        name=model.name,
        model=model.model,
        display_name=model.display_name,
        description=model.description,
        supports_thinking=model.supports_thinking,
        supports_reasoning_effort=model.supports_reasoning_effort,
    )
