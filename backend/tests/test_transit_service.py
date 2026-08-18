"""Tests for the transit service layer (no-DB, live-fetch design).

The oneai apiKey is fetched live from YiXin and never persisted, so these tests
mock the credential cache (``get_cached_api_key``) rather than any DB/repo.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.gateway.auth.errors import TokenError
from app.gateway.transit.service import (
    ensure_transit_credential,
    fetch_transit_models,
    get_yx_uuid_from_request,
    is_transit_user,
)
from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config


@pytest.fixture
def request_with_state():
    return SimpleNamespace(app=SimpleNamespace(), cookies={})


@pytest.fixture(autouse=True)
def _stub_app_config(monkeypatch):
    """Keep tests independent from a developer-local config.yaml."""
    set_app_config(AppConfig.model_validate({"sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"}}))
    yield
    reset_app_config()


def _payload(yx_uuid=None):
    return SimpleNamespace(yx_uuid=yx_uuid)


class TestGetYxUuidFromRequest:
    def test_none_without_cookie(self, request_with_state, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.decode_token", lambda t: None)
        assert get_yx_uuid_from_request(request_with_state) is None

    def test_none_on_token_error(self, request_with_state, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.decode_token", lambda t: TokenError.MALFORMED)
        assert get_yx_uuid_from_request(request_with_state) is None

    def test_returns_claim(self, request_with_state, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.decode_token", lambda t: _payload("oncon1"))
        assert get_yx_uuid_from_request(request_with_state) == "oncon1"


class TestIsTransitUser:
    def test_false_without_uuid(self, request_with_state, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.decode_token", lambda t: _payload(None))
        assert is_transit_user(request_with_state) is False

    def test_true_with_uuid(self, request_with_state, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.decode_token", lambda t: _payload("oncon1"))
        assert is_transit_user(request_with_state) is True


class TestEnsureTransitCredential:
    @pytest.mark.anyio
    async def test_false_when_not_configured(self, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.is_yixin_transit_configured", lambda: False)
        assert await ensure_transit_credential("oncon1") is False

    @pytest.mark.anyio
    async def test_true_when_key_resolved(self, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.is_yixin_transit_configured", lambda: True)
        monkeypatch.setattr(
            "app.gateway.transit.service.get_cached_api_key", AsyncMock(return_value="sk-1")
        )
        assert await ensure_transit_credential("oncon1") is True

    @pytest.mark.anyio
    async def test_false_when_upstream_fails(self, monkeypatch):
        monkeypatch.setattr("app.gateway.transit.service.is_yixin_transit_configured", lambda: True)
        monkeypatch.setattr(
            "app.gateway.transit.service.get_cached_api_key", AsyncMock(return_value=None)
        )
        assert await ensure_transit_credential("oncon1") is False


class TestFetchTransitModels:
    @pytest.mark.anyio
    async def test_503_when_no_key(self, monkeypatch):
        monkeypatch.setattr(
            "app.gateway.transit.service.get_cached_api_key", AsyncMock(return_value=None)
        )
        with pytest.raises(HTTPException) as exc:
            await fetch_transit_models("oncon1")
        assert exc.value.status_code == 503

    @pytest.mark.anyio
    async def test_returns_models(self, monkeypatch):
        monkeypatch.setattr(
            "app.gateway.transit.service.get_cached_api_key", AsyncMock(return_value="sk-1")
        )
        monkeypatch.setattr(
            "app.gateway.transit.service.get_transit_catalog",
            AsyncMock(return_value=[SimpleNamespace(name="m1", display_name="Model 1")]),
        )
        models = await fetch_transit_models("oncon1")
        assert models == [
            {"name": "m1", "display_name": "Model 1", "supported_endpoint_types": ["openai"]}
        ]
