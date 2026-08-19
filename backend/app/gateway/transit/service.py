"""Transit credential service: live fetch + in-memory cache (no at-rest storage).

The oneai apiKey is fetched live from the YiXin token interface on every use
and **never persisted** — there is no ``user_transit_credentials`` table and no
encryption key. The YiXin interface is the durable source of truth, so a user's
key can always be re-fetched; this module only keeps a last-good fallback in
process memory (see :mod:`app.gateway.transit.credential_cache`).

The user's ``yx_uuid`` (YiXin identity, a non-secret user identifier) is carried
in the session JWT claim so it is available on every request without a DB lookup.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, Request

from app.gateway.auth.jwt import TokenError, decode_token
from app.gateway.transit.config import get_transit_config, is_yixin_transit_configured
from app.gateway.transit.credential_cache import (
    get_cached_api_key,
    get_transit_default_model,
    set_transit_default_model,
)
from deerflow.runtime.transit import get_transit_catalog

logger = logging.getLogger(__name__)

__all__ = [
    "get_yx_uuid_from_request",
    "is_transit_user",
    "ensure_transit_credential",
    "fetch_transit_models",
    "get_transit_default_model",
    "set_transit_default_model",
]

_ACCESS_TOKEN_COOKIE = "access_token"


def get_yx_uuid_from_request(request: Request) -> str | None:
    """Return the YiXin ``onconUUID`` for the current session, or None.

    Read from the ``yx_uuid`` claim stamped into the session JWT at CAS login.
    This is a non-secret user identifier (equivalent to an email), not the
    apiKey. Returns None for anonymous requests or non-Yixin sessions.
    """
    token = request.cookies.get(_ACCESS_TOKEN_COOKIE)
    if not token:
        return None
    payload = decode_token(token)
    if isinstance(payload, TokenError):
        return None
    yx_uuid = getattr(payload, "yx_uuid", None)
    return yx_uuid or None


def is_transit_user(request: Request) -> bool:
    """True when the current session belongs to a Yixin SSO user.

    Derived from the ``yx_uuid`` JWT claim — no DB lookup, no I/O.
    """
    return get_yx_uuid_from_request(request) is not None


async def ensure_transit_credential(yx_uuid: str) -> bool:
    """Provision (refresh) the user's oneai apiKey from the YiXin token interface.

    Always performs a live ``getUserApiKeyByUuid`` fetch, so the credential is
    the latest one. Returns True when a key was obtained. Never raises for
    transient YiXin failures (login must not be blocked); on failure the
    previous good key (if any) is retained and False is returned only when no
    key has ever been fetched.
    """
    if not is_yixin_transit_configured():
        logger.warning("YiXin transit not configured; skipping credential provisioning for %s", yx_uuid)
        return False
    if not yx_uuid:
        return False
    api_key = await get_cached_api_key(yx_uuid)
    return api_key is not None


async def fetch_transit_models(yx_uuid: str) -> list[dict[str, Any]]:
    """Fetch the oneai model list for a user's apiKey.

    Uses the shared, globally-cached catalog (``runtime/transit.get_transit_catalog``,
    keyed by ``base_url``) so every Yixin user shares one upstream fetch instead of
    each triggering their own. Raises ``HTTPException`` (503) when the credential is
    missing or the upstream call fails.
    """
    api_key = await get_cached_api_key(yx_uuid)
    if not api_key:
        raise HTTPException(status_code=503, detail="用户未配置模型凭证（has_api_key=false）")

    base_url = get_transit_config().base_url
    try:
        catalog = await get_transit_catalog(base_url, api_key)
    except Exception as exc:  # noqa: BLE001 - surface as 503 so the router can degrade
        raise HTTPException(status_code=503, detail=f"获取模型列表失败：{exc}") from exc

    # Free models (name/display_name contains "免费") are surfaced first so the
    # default selection (models[0]) prefers a free one; order within each group
    # stays stable (catalog order).
    sorted_catalog = sorted(
        catalog,
        key=lambda m: (1 if ("免费" in (m.name or "") or "免费" in (m.display_name or "")) else 0),
    )
    return [
        {
            "name": model.name,
            "display_name": model.display_name or model.name,
            "supported_endpoint_types": ["openai"],
            "free": "免费" in (model.name or "") or "免费" in (model.display_name or model.name),
        }
        for model in sorted_catalog
    ]
