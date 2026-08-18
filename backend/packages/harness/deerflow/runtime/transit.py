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

import logging
import time
from typing import Any

import httpx

from deerflow.config.model_config import ModelConfig

logger = logging.getLogger(__name__)

_TRANSIT_MODEL_USE = "langchain_openai:ChatOpenAI"
_CATALOG_TTL_SECONDS = 60.0

# base_url -> (fetched_at, list[ModelConfig])
_catalog_cache: dict[str, tuple[float, list[ModelConfig]]] = {}


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


def build_transit_model_configs(base_url: str, model_ids: list[str]) -> list[ModelConfig]:
    """Build one ModelConfig per transit model id (base_url set, no api_key)."""
    return [
        ModelConfig(
            name=model_id,
            display_name=model_id,
            use=_TRANSIT_MODEL_USE,
            model=model_id,
            base_url=base_url,
            # oneai 对话接口与模型列表一致默认 gzip 压缩；带上空 Accept-Encoding
            # 禁用压缩，避免 ChatOpenAI 收到压缩字节导致解析失败（LLM fallback）。
            default_headers={"Accept-Encoding": ""},
        )
        for model_id in model_ids
    ]


async def get_transit_catalog(
    base_url: str,
    api_key: str,
    *,
    ttl: float = _CATALOG_TTL_SECONDS,
) -> list[ModelConfig]:
    """Return the cached transit model catalog for a relay, fetching on miss.

    Cached globally by ``base_url`` (the relay's model list is the same for
    every user; only apiKey differs). A failed fetch is not cached and raises.
    """
    now = time.monotonic()
    cached = _catalog_cache.get(base_url)
    if cached is not None and now - cached[0] < ttl:
        return cached[1]

    ids = await fetch_transit_model_ids(base_url, api_key)
    models = build_transit_model_configs(base_url, ids)
    _catalog_cache[base_url] = (now, models)
    return models


def invalidate_transit_catalog(base_url: str) -> None:
    """Drop the cached catalog for a relay (used by the refresh endpoint)."""
    _catalog_cache.pop(base_url, None)


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
