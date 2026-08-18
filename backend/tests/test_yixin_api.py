"""Tests for the YiXin (易token) API client: token cache + business invoke."""

from __future__ import annotations

import pytest

from app.gateway.transit.yixin_api import YiXinAPIClient, YiXinAPIError


@pytest.fixture
def client() -> YiXinAPIClient:
    return YiXinAPIClient(
        appid="yx_test",
        secret="secret",
        base_url="https://jk.teamshub.com/",
        resource="CodeMate",
    )


class TestYiXinTokenCache:
    @pytest.mark.anyio
    async def test_global_cache_hit_avoids_refetch(self, client, monkeypatch):
        from app.gateway.transit import yixin_api

        fetched = []

        async def fake_post(self, *args, **kwargs):
            fetched.append(True)

            class R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return {"access_token": "t1"}

            return R()

        monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
        yixin_api._token_cache.set("cached-token")
        try:
            token = await client.get_access_token()
            assert token == "cached-token"
            assert fetched == []
        finally:
            yixin_api._token_cache.invalidate()

    @pytest.mark.anyio
    async def test_expired_cache_refetches(self, client, monkeypatch):
        """An expired / absent cache entry triggers a fresh token fetch."""
        from app.gateway.transit import yixin_api

        yixin_api._token_cache.invalidate()

        hit = {}

        class FakeClient:
            def __init__(self, _base_url: str = ""):
                pass

            async def post(self, *args, **kwargs):
                hit["called"] = True
                return FakeResp()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        class FakeResp:
            def raise_for_status(self):
                pass

            def json(self):
                return {"access_token": "fresh"}

        monkeypatch.setattr(client, "_http_client", lambda: FakeClient())

        token = await client.get_access_token()
        assert token == "fresh"
        assert hit["called"] is True
        yixin_api._token_cache.invalidate()


class TestYiXinInvoke:
    @pytest.mark.anyio
    async def test_invoke_builds_payload_and_authorization(self, monkeypatch, client):
        captured = {}

        async def fake_invoke(self, api_name, version, body):
            captured["api_name"] = api_name
            captured["version"] = version
            captured["body"] = body
            return {"status": "0", "data": {"apiKey": "sk-x"}}

        monkeypatch.setattr(YiXinAPIClient, "_invoke", fake_invoke)

        api_key = await client.get_user_api_key("oncon123")
        assert api_key == "sk-x"
        assert captured["api_name"] == "getUserApiKeyByUuid"
        assert captured["version"] == "1.0"
        assert captured["body"]["uuid"] == "oncon123"

    @pytest.mark.anyio
    async def test_invoke_raises_on_status_not_zero(self, monkeypatch, client):
        async def fake_invoke(self, api_name, version, body):
            return {"status": "1", "desc": "boom"}

        monkeypatch.setattr(YiXinAPIClient, "_invoke", fake_invoke)

        with pytest.raises(YiXinAPIError, match="boom"):
            await client.get_user_api_key("oncon123")

    @pytest.mark.anyio
    async def test_get_user_quota_returns_data(self, monkeypatch, client):
        async def fake_invoke(self, api_name, version, body):
            return {"status": "0", "data": {"quota": 100.5, "usedQuota": 12.0}}

        monkeypatch.setattr(YiXinAPIClient, "_invoke", fake_invoke)

        quota = await client.get_user_quota("oncon123")
        assert quota == {"quota": 100.5, "usedQuota": 12.0}