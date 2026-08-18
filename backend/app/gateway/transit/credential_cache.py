"""Per-process transit credential cache (no at-rest storage).

The oneai apiKey is the user's model credential, obtained live from the YiXin
token interface (``getUserApiKeyByUuid``). It is **never persisted**: there is
no ``user_transit_credentials`` row, no encryption key, and nothing written to
disk. The YiXin interface is the durable source of truth, so "not lost" is
guaranteed by being able to re-fetch it on demand.

This module keeps two small in-memory structures:

- ``_api_key_cache`` — ``yx_uuid -> last good apiKey``. Used purely as a
  *fallback*: every call to :func:`get_cached_api_key` performs a live YiXin
  fetch (so the returned key is always the latest), and on upstream failure we
  return the last good value if we have one rather than degrading a user who
  already had a working key.
- ``_default_model_cache`` — ``user_id -> default model name``. A non-secret
  user preference; the frontend localStorage copy remains authoritative, this
  just lets the server echo it back on ``/api/models`` and ``/me``.

Both are process-local. Under ``GATEWAY_WORKERS > 1`` each worker fetches its
own copy from YiXin (cheap, token-cached 2h); the fallback cache means a
transient YiXin outage does not break an already-provisioned user.
"""

from __future__ import annotations

import logging
from typing import Dict

from app.gateway.transit.config import (
    get_oncon_app_config,
    is_yixin_transit_configured,
)
from app.gateway.transit.yixin_api import YiXinAPIClient

logger = logging.getLogger(__name__)

_api_key_cache: Dict[str, str] = {}
_default_model_cache: Dict[str, str] = {}


def _build_client() -> YiXinAPIClient:
    oncon = get_oncon_app_config()
    return YiXinAPIClient(
        appid=oncon.appid,
        secret=oncon.secret,
        base_url=oncon.baseurl,
        resource=oncon.resource,
    )


async def get_cached_api_key(yx_uuid: str) -> str | None:
    """Return the latest oneai apiKey for ``yx_uuid``, fetching live from YiXin.

    Always performs a live ``getUserApiKeyByUuid`` call so the returned key is
    the current one (never a stale cached copy). On upstream failure it returns
    the last good value if cached, otherwise ``None`` — so a transient YiXin
    outage never wipes a working user's key. Never raises.
    """
    if not is_yixin_transit_configured() or not yx_uuid:
        return None
    try:
        api_key = await _build_client().get_user_api_key(yx_uuid)
    except Exception as exc:  # noqa: BLE001 - degrade to last good / None
        logger.warning("YiXin getUserApiKeyByUuid failed for %s: %s", yx_uuid, exc)
        return _api_key_cache.get(yx_uuid)
    if api_key:
        _api_key_cache[yx_uuid] = api_key
    return api_key


def get_transit_default_model(user_id: str) -> str | None:
    """Return the server-remembered default model for the user, if any."""
    return _default_model_cache.get(user_id)


def set_transit_default_model(user_id: str, model_name: str) -> None:
    """Remember the user's selected default model (non-secret preference)."""
    _default_model_cache[user_id] = model_name
