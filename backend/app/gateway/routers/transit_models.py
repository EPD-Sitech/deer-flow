"""Transit endpoints (Yixin SSO + oneai dynamic models).

- ``POST /api/models/refresh`` — force-refetch oneai models for the current Yixin user
- ``PUT /api/users/me/default-model`` — record the user's selected model
- ``GET /api/users/me/quota`` — oneai quota (backend only, not displayed)

``GET /api/models`` itself lives in ``routers/models.py`` (transit-aware there)
to avoid duplicate route registration.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.gateway.deps import get_optional_user_from_request
from app.gateway.transit.config import get_oncon_app_config
from app.gateway.transit.service import (
    ensure_transit_credential,
    fetch_transit_models,
    get_transit_default_model,
    get_yx_uuid_from_request,
    set_transit_default_model,
)
from app.gateway.transit.yixin_api import YiXinAPIClient, YiXinAPIError
from deerflow.config.app_config import get_app_config

logger = logging.getLogger(__name__)

router = APIRouter(tags=["transit"])


class TransitModelInfo(BaseModel):
    """A model entry returned to the frontend."""

    name: str = Field(..., description="Model identifier (passed as model_name at run time)")
    display_name: str | None = Field(None, description="Human-readable label")
    description: str | None = Field(None, description="Optional description")
    supports_thinking: bool = Field(default=False, description="Whether thinking mode is supported")
    supports_reasoning_effort: bool = Field(default=False, description="Whether reasoning effort is supported")


class TransitModelsResponse(BaseModel):
    models: list[TransitModelInfo]
    default_model: str | None = None
    is_yixin_user: bool = False
    has_api_key: bool = False


class SetDefaultModelRequest(BaseModel):
    model_name: str = Field(..., min_length=1, max_length=128)


class SetDefaultModelResponse(BaseModel):
    default_model: str


class QuotaResponse(BaseModel):
    quota: float | None = None
    used_quota: float | None = None


def _transit_model_info(item: dict[str, Any]) -> TransitModelInfo:
    return TransitModelInfo(
        name=item["name"],
        display_name=item.get("display_name") or item["name"],
        description=None,
        # "免费" models are surfaced first by the service layer; echo the flag so
        # the UI can mark/select them without re-deriving the rule.
        free=bool(item.get("free")),
    )


async def _current_user_id(request: Request) -> str | None:
    user = await get_optional_user_from_request(request)
    return str(user.id) if user else None


@router.post(
    "/api/models/refresh",
    response_model=TransitModelsResponse,
    summary="Refresh oneai Models",
    description="Force-refetch the oneai model list for the current Yixin user and return it.",
)
async def refresh_models(request: Request) -> TransitModelsResponse:
    user_id = await _current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    yx_uuid = get_yx_uuid_from_request(request)
    if not yx_uuid:
        # Not a Yixin user — nothing to refresh; return the static catalog.
        config = get_app_config()
        models = [
            TransitModelInfo(
                name=m.name,
                display_name=m.display_name or m.name,
                description=m.description,
                supports_thinking=m.supports_thinking,
                supports_reasoning_effort=m.supports_reasoning_effort,
            )
            for m in config.models
        ]
        return TransitModelsResponse(models=models)

    # Yixin user: (re)fetch the latest oneai apiKey live from YiXin before
    # refreshing the model list. This makes the "凭证获取失败，请点击刷新重试"
    # flow actually recover — a transient failure at CAS-login time is retried
    # here by calling getUserApiKeyByUuid again, rather than only re-fetching the
    # (still-empty) model list and 503-ing. The apiKey is never persisted.
    try:
        await ensure_transit_credential(yx_uuid)
    except Exception:  # noqa: BLE001 - degrade to the fetch below; it surfaces the real error
        logger.warning("Transit credential re-provision failed for user %s", user_id, exc_info=True)

    # Drop the 60s process cache so "refresh" returns genuinely fresh relay data.
    from app.gateway.transit.config import get_transit_config
    from deerflow.runtime.transit import invalidate_transit_catalog

    invalidate_transit_catalog(get_transit_config().base_url)

    transit_models = await fetch_transit_models(yx_uuid)
    return TransitModelsResponse(
        models=[_transit_model_info(m) for m in transit_models],
        default_model=get_transit_default_model(user_id),
        is_yixin_user=True,
        has_api_key=True,
    )


@router.put(
    "/api/users/me/default-model",
    response_model=SetDefaultModelResponse,
    summary="Record Selected Model",
    description="Record the user's currently selected model (persisted per user).",
)
async def set_default_model(request: Request, body: SetDefaultModelRequest) -> SetDefaultModelResponse:
    user_id = await _current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    # The default model is a non-secret user preference; the frontend localStorage
    # copy remains authoritative, and we echo it back via /api/models and /me.
    # No DB row is involved.
    if get_yx_uuid_from_request(request) is None:
        return SetDefaultModelResponse(default_model=body.model_name)
    set_transit_default_model(user_id, body.model_name)
    return SetDefaultModelResponse(default_model=body.model_name)


@router.get(
    "/api/users/me/quota",
    response_model=QuotaResponse,
    summary="Get oneai Quota (backend only)",
    description="Query the user's oneai quota via the YiXin token interface. Not displayed in the UI yet.",
)
async def get_quota(request: Request) -> QuotaResponse:
    user_id = await _current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    yx_uuid = get_yx_uuid_from_request(request)
    if not yx_uuid:
        raise HTTPException(status_code=404, detail="用户未配置模型凭证")

    oncon = get_oncon_app_config()
    if not oncon.appid:
        raise HTTPException(status_code=503, detail="易token 未配置")

    client = YiXinAPIClient(
        appid=oncon.appid,
        secret=oncon.secret,
        base_url=oncon.baseurl,
        resource=oncon.resource,
    )
    try:
        quota = await client.get_user_quota(yx_uuid)
    except YiXinAPIError as exc:
        raise HTTPException(status_code=502, detail=f"查询余额失败：{exc}") from exc
    except Exception as exc:  # noqa: BLE001 - surface as 502
        raise HTTPException(status_code=502, detail=f"查询余额失败：{exc}") from exc

    return QuotaResponse(
        quota=quota.get("quota"),
        used_quota=quota.get("usedQuota"),
    )
