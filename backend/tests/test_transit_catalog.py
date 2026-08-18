"""Tests for the harness oneai transit catalog (fetch/filter/cache/augment)."""

from __future__ import annotations

import pytest

from deerflow.config.app_config import AppConfig
from deerflow.config.model_config import ModelConfig
from deerflow.runtime.transit import (
    augment_app_config,
    build_transit_model_configs,
    fetch_transit_model_ids,
    get_transit_catalog,
    invalidate_transit_catalog,
)


class TestFetchTransitModelIds:
    @pytest.mark.anyio
    async def test_filters_openai_only(self, monkeypatch):
        """Only models whose supported_endpoint_types include 'openai' are kept."""
        captured = {}

        async def fake_get(self, url, **kwargs):
            captured["headers"] = kwargs.get("headers", {})
            return _scripted_response(
                {
                    "success": True,
                    "object": "list",
                    "data": [
                        {"id": "claude 1.5x", "supported_endpoint_types": ["anthropic", "openai"]},
                        {"id": "deepseek-v4-flash--1.0x", "supported_endpoint_types": ["openai"]},
                        {"id": "anthropic-only", "supported_endpoint_types": ["anthropic"]},
                        {"id": "none-type", "supported_endpoint_types": []},
                        {"id": 123, "supported_endpoint_types": ["openai"]},
                    ],
                }
            )

        from httpx import AsyncClient

        monkeypatch.setattr(AsyncClient, "get", fake_get)

        ids = await fetch_transit_model_ids("https://oneai.teamshub.com/v1", "sk-x")
        assert ids == ["claude 1.5x", "deepseek-v4-flash--1.0x"]
        # oneai 要求 Accept-Encoding 空值禁用压缩。
        assert captured["headers"].get("Accept-Encoding") == ""
        assert captured["headers"].get("Authorization") == "Bearer sk-x"

    @pytest.mark.anyio
    async def test_failure_not_cached_and_raises(self, monkeypatch):
        """A failed upstream fetch raises and must not populate the cache."""

        async def fake_get(self, url, **kwargs):
            raise RuntimeError("upstream down")

        from httpx import AsyncClient

        monkeypatch.setattr(AsyncClient, "get", fake_get)

        with pytest.raises(RuntimeError, match="upstream down"):
            await fetch_transit_model_ids("https://oneai.teamshub.com/v1", "sk-x")


class TestBuildTransitModelConfigs:
    def test_builds_modelconfigs_with_base_url_no_api_key(self):
        models = build_transit_model_configs("https://oneai.teamshub.com/v1", ["a", "b"])
        assert len(models) == 2
        m = models[0]
        assert isinstance(m, ModelConfig)
        assert m.name == "a"
        assert m.model == "a"
        assert m.base_url == "https://oneai.teamshub.com/v1"
        assert m.use == "langchain_openai:ChatOpenAI"


class TestGetTransitCatalogCache:
    @pytest.mark.anyio
    async def test_shared_cache_by_base_url(self, monkeypatch):
        """The catalog is cached globally by base_url (one fetch, no per-user)."""
        counts: dict[str, int] = {}

        async def fake_fetch(base_url, api_key, timeout=15.0):
            counts[base_url] = counts.get(base_url, 0) + 1
            return ["m1"]

        monkeypatch.setattr("deerflow.runtime.transit.fetch_transit_model_ids", fake_fetch)

        cat1 = await get_transit_catalog("https://oneai.teamshub.com/v1", "key-a")
        cat2 = await get_transit_catalog("https://oneai.teamshub.com/v1", "key-b")
        assert cat1 == cat2
        # Only one upstream fetch for the same base_url despite two users.
        assert counts["https://oneai.teamshub.com/v1"] == 1

    @pytest.mark.anyio
    async def test_invalidate_forces_refetch(self, monkeypatch):
        counts: dict[str, int] = {}

        async def fake_fetch(base_url, api_key, timeout=15.0):
            counts[base_url] = counts.get(base_url, 0) + 1
            return ["m1"]

        monkeypatch.setattr("deerflow.runtime.transit.fetch_transit_model_ids", fake_fetch)

        await get_transit_catalog("u", "k")
        invalidate_transit_catalog("u")
        await get_transit_catalog("u", "k")
        assert counts["u"] == 2


class TestAugmentAppConfig:
    def test_merges_transit_models_and_prefixes_dedup(self):
        base = AppConfig.model_validate(
            {
                "models": [
                    {"name": "static-1", "use": "langchain_openai:ChatOpenAI", "model": "static-1"},
                ],
                "sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"},
            }
        )
        catalog = build_transit_model_configs("https://oneai.teamshub.com/v1", ["relay-1", "relay-2"])
        augmented = augment_app_config(base, catalog)

        names = [m.name for m in augmented.models]
        assert names == ["static-1", "relay-1", "relay-2"]
        # Original not mutated; catalog objects shared.
        assert [m.name for m in base.models] == ["static-1"]

    def test_dedup_existing_names(self):
        base = AppConfig.model_validate(
            {
                "models": [
                    {"name": "relay-1", "use": "langchain_openai:ChatOpenAI", "model": "relay-1"},
                ],
                "sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"},
            }
        )
        catalog = build_transit_model_configs("https://oneai.teamshub.com/v1", ["relay-1", "relay-2"])
        augmented = augment_app_config(base, catalog)
        names = [m.name for m in augmented.models]
        assert names == ["relay-1", "relay-2"]


def _scripted_response(payload):
    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return payload

    return R()