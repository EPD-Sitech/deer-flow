"""Transit (oneai relay) runtime helpers.

Provides:
- ``fetch_transit_model_ids``   — GET {base_url}/models (Accept-Encoding empty header),
  filter ``supported_endpoint_types`` containing "openai", return the model ids.
- ``get_transit_catalog``        — cached ``list[ModelConfig]`` keyed by base_url
  (the catalog is identical for every user sharing the relay, so it is a global
  resource; only the apiKey is per-user).
- ``augment_app_config``         — build an AppConfig whose ``models`` include the
  transit catalog so the agent factory can resolve a transit model name.

Lives in the harness so the run worker can use it without importing app code.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import time
from typing import Any

import httpx

from deerflow.config.model_config import ModelConfig

logger = logging.getLogger(__name__)

# oneai repeats the full ``usage`` in every streaming chunk for some models,
# which ``langchain_openai`` then *sums* across chunks and inflates token
# counts. Route all transit models through the patched adapter that keeps only
# the last chunk's ``usage`` (see ``deerflow/models/patched_oneai.py``).
_TRANSIT_MODEL_USE = "deerflow.models.patched_oneai:PatchedChatONEAI"
_CATALOG_TTL_SECONDS = 60.0

# (base_url, profile_signature) -> (fetched_at, list[ModelConfig])
_catalog_cache: dict[object, tuple[float, list[ModelConfig]]] = {}


def _build_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        # oneai 默认返回 gzip 压缩；空字符串禁用压缩，否则无法解析 JSON。
        "Accept-Encoding": "",
        "Content-Type": "application/json",
    }


async def fetch_transit_model_ids(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 15.0,
) -> list[str]:
    """GET {base_url}/models and return the ids of OpenAI-compatible models.

    Raises ``httpx.HTTPError`` / ``ValueError`` on failure; the catalog cache
    is only populated from successful responses.
    """
    url = f"{base_url.rstrip('/')}/models"
    headers = _build_headers(api_key)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    if not (data or {}).get("success"):
        raise ValueError(f"oneai /v1/models returned failure: {data}")

    ids: list[str] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        endpoint_types = item.get("supported_endpoint_types") or []
        if "openai" not in endpoint_types:
            continue
        ids.append(model_id)
    return ids


# Capability fields a profile may set on a transit model. Anything else in a
# profile entry is ignored, so adding new knobs later needs no caller change.
_PROFILE_CAPABILITY_KEYS = (
    "supports_thinking",
    "supports_reasoning_effort",
    "supports_vision",
    "when_thinking_enabled",
    "when_thinking_disabled",
)


def _match_profile(model_id: str, profiles: list[dict] | None) -> dict | None:
    """Return the first profile whose ``match`` glob matches ``model_id``."""
    if not profiles:
        return None
    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        pattern = profile.get("match")
        if isinstance(pattern, str) and fnmatch.fnmatch(model_id, pattern):
            return profile
    return None


def build_transit_model_configs(
    base_url: str,
    model_ids: list[str],
    profiles: list[dict] | None = None,
) -> list[ModelConfig]:
    """Build one ModelConfig per transit model id (base_url set, no api_key).

    When ``profiles`` is provided, the first profile whose ``match`` glob matches
    a model id injects capability fields (``supports_thinking``,
    ``supports_reasoning_effort``, ``supports_vision``, ``when_thinking_enabled``,
    ``when_thinking_disabled``) so the 闪速/思考/pro mode stack actually takes
    effect. Models with no matching profile keep the conservative defaults
    (thinking off) — e.g. non-thinking variants stay safe.
    """
    configs: list[ModelConfig] = []
    for model_id in model_ids:
        cfg = ModelConfig(
            name=model_id,
            display_name=model_id,
            use=_TRANSIT_MODEL_USE,
            model=model_id,
            base_url=base_url,
            # oneai 对话接口与模型列表一致默认 gzip 压缩；带上空 Accept-Encoding
            # 禁用压缩，避免 ChatOpenAI 收到压缩字节导致解析失败（LLM fallback）。
            default_headers={"Accept-Encoding": ""},
        )
        profile = _match_profile(model_id, profiles)
        if profile:
            for key in _PROFILE_CAPABILITY_KEYS:
                if key in profile:
                    setattr(cfg, key, profile[key])
        configs.append(cfg)
    return configs


async def get_transit_catalog(
    base_url: str,
    api_key: str,
    *,
    ttl: float = _CATALOG_TTL_SECONDS,
    profiles: list[dict] | None = None,
) -> list[ModelConfig]:
    """Return the cached transit model catalog for a relay, fetching on miss.

    Cached globally by ``(base_url, profile_signature)`` (the relay's model list
    is the same for every user; only apiKey differs). ``profiles`` influence the
    built ModelConfigs, so they are part of the cache key — changing the
    capability profile refreshes the catalog. A failed fetch is not cached and
    raises.
    """
    cache_key = (base_url, _profile_signature(profiles))
    now = time.monotonic()
    cached = _catalog_cache.get(cache_key)
    if cached is not None and now - cached[0] < ttl:
        return cached[1]

    ids = await fetch_transit_model_ids(base_url, api_key)
    models = build_transit_model_configs(base_url, ids, profiles)
    _catalog_cache[cache_key] = (now, models)
    return models


def _profile_signature(profiles: list[dict] | None) -> str:
    """Stable signature for the catalog cache key."""
    if not profiles:
        return ""
    try:
        return json.dumps(profiles, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return str(profiles)


def invalidate_transit_catalog(base_url: str) -> None:
    """Drop the cached catalog for a relay (used by the refresh endpoint).

    The cache key is ``(base_url, profile_signature)``, so every signature
    variant for this relay is cleared.
    """
    for key in list(_catalog_cache.keys()):
        if isinstance(key, tuple) and key[0] == base_url:
            _catalog_cache.pop(key, None)


def augment_app_config(app_config: Any, catalog: list[ModelConfig]) -> Any:
    """Return an AppConfig whose ``models`` include the transit catalog.

    The original AppConfig is not mutated; ``model_copy`` is cheap (the catalog
    ModelConfig objects are shared from the global cache).
    """
    existing = list(app_config.models)
    merged = list(existing)
    seen = {m.name for m in existing}
    for model in catalog:
        if model.name not in seen:
            merged.append(model)
            seen.add(model.name)
    augmented = app_config.model_copy(update={"models": merged})
    # ``model_copy`` does not run the pydantic ``model_validator(mode="after")``,
    # so the private ``_models_by_name`` index keeps the *static* catalog — a
    # transit model name would then fail ``get_model_config`` and fall back to
    # ``models[0]`` (observed: oneai ``deepseek-...`` silently became ``minimax-m3``).
    # Rebuild the index on the copy so the oneai model resolves.
    rebuild = getattr(augmented, "_build_name_indexes", None)
    if callable(rebuild):
        rebuild()
    return augmented
