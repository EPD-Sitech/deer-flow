"""Tests for CAS SSO configuration, provider info, and ticket validation.

These run offline: config loading is exercised against a stubbed
``get_app_config()``, and ticket validation uses a fake httpx client so no
network is touched.
"""

import pytest

import app.gateway.auth.cas_auth as cas_auth
import app.gateway.auth.cas_config as cas_config
from deerflow.config.auth_config import CASAppConfig


def _clear_env(monkeypatch) -> None:
    for key in (
        "CAS_ENABLED",
        "CAS_DISPLAY_NAME",
        "CAS_LOGIN_URL",
        "CAS_VALIDATE_URL",
        "CAS_LOGOUT_URL",
        "CAS_SERVICE_URL",
        "CAS_EMAIL_DOMAIN",
    ):
        monkeypatch.delenv(key, raising=False)


def _fake_get_app_config(cas: CASAppConfig):
    from types import SimpleNamespace

    return lambda: SimpleNamespace(auth=SimpleNamespace(cas=cas))


# ── get_cas_config: config.yaml (auth.cas) ─────────────────────────────────


def test_cas_config_reads_auth_cas_from_config(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _fake_get_app_config(
            CASAppConfig(
                enabled=True,
                display_name="配置登录",
                login_url="https://cfg/login",
                validate_url="https://cfg/validate",
                logout_url="https://cfg/logout",
                service_url="https://cfg/callback",
                email_domain="example.com",
            )
        ),
    )
    cfg = cas_config.get_cas_config()
    assert cfg.enabled is True
    assert cfg.display_name == "配置登录"
    assert cfg.login_url == "https://cfg/login"
    assert cfg.service_url == "https://cfg/callback"
    assert cfg.email_domain == "example.com"


def test_cas_config_env_overrides_config(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("CAS_ENABLED", "false")
    monkeypatch.setenv("CAS_SERVICE_URL", "https://env/callback")
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _fake_get_app_config(CASAppConfig(enabled=True, service_url="https://cfg/callback")),
    )
    cfg = cas_config.get_cas_config()
    assert cfg.enabled is False
    assert cfg.service_url == "https://env/callback"


def test_cas_config_defaults_disabled(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _fake_get_app_config(CASAppConfig()),
    )
    cfg = cas_config.get_cas_config()
    assert cfg.enabled is False
    assert cfg.login_url == ""


# ── get_cas_provider_info ──────────────────────────────────────────────────


def test_cas_provider_info_none_when_disabled(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _fake_get_app_config(CASAppConfig()),
    )
    assert cas_config.get_cas_provider_info() is None


def test_cas_provider_info_when_enabled(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _fake_get_app_config(CASAppConfig(enabled=True, display_name="易信登录")),
    )
    assert cas_config.get_cas_provider_info() == {
        "id": "yixin",
        "display_name": "易信登录",
        "type": "cas",
    }


# ── validate_ticket: service param always from config ──────────────────────


class _FakeResponse:
    raise_for_status = lambda self: None  # noqa: E731
    text = '<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:attributes im_username="zhangsan" onconParam="aWQ9MQ==" /></cas:serviceResponse>'


class _FakeClient:
    def __init__(self, *args, **kwargs):
        self.captured = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url):
        self.captured = url
        return _FakeResponse()


@pytest.mark.anyio
async def test_validate_ticket_uses_configured_service(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr("app.gateway.auth.cas_auth.is_cas_enabled", lambda: True)
    monkeypatch.setattr(
        "app.gateway.auth.cas_auth.get_cas_config",
        lambda: cas_config.CASConfig(
            enabled=True,
            validate_url="https://cas/v?existing=1",
            service_url="https://svc/callback",
        ),
    )
    fake = _FakeClient()
    monkeypatch.setattr("app.gateway.auth.cas_auth.httpx.AsyncClient", lambda *a, **k: fake)

    result = await cas_auth.validate_ticket("ST-1", service_url=None)

    assert result.authenticated is True
    assert result.username == "zhangsan"
    assert result.identifier == "zhangsan"
    # The service parameter must be exactly the configured service_url (with an
    # existing query on validate_url appended via "&", never a double "?").
    assert fake.captured.startswith("https://cas/v?existing=1&ticket=ST-1&service=")
    assert "service=https%3A%2F%2Fsvc%2Fcallback" in fake.captured


@pytest.mark.anyio
async def test_validate_ticket_disabled_short_circuits(monkeypatch):
    monkeypatch.setattr("app.gateway.auth.cas_auth.is_cas_enabled", lambda: False)
    result = await cas_auth.validate_ticket("ST-1")
    assert result.authenticated is False