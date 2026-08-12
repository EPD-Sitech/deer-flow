"""CAS (Central Authentication Service) configuration for Yixin/Teamshub SSO."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class CASConfig:
    """Configuration for CAS SSO authentication.

    Attributes:
        enabled: Whether CAS SSO is enabled
        display_name: Display name shown on login button
        login_url: CAS login page URL
        validate_url: CAS ticket validation URL
        logout_url: CAS logout URL
        service_url: Callback URL for CAS authentication
        email_domain: Email domain suffix for SSO users
    """

    enabled: bool = False
    display_name: str = "易信登录"
    login_url: str = ""
    validate_url: str = ""
    logout_url: str = ""
    service_url: str = ""
    email_domain: str = "si-tech.com.cn"


def get_cas_config() -> CASConfig:
    """Load CAS configuration from config.yaml ``auth.cas`` with env overrides.

    Precedence (low → high): dataclass defaults < config.yaml ``auth.cas`` <
    ``CAS_*`` environment variables. Environment overrides are applied only
    when the corresponding variable is actually set, so ``auth.cas`` in
    ``config.yaml`` remains effective even when ``CAS_ENABLED`` is unset.

    Environment variables:
        CAS_ENABLED: Enable CAS SSO (default: false)
        CAS_LOGIN_URL: CAS login page URL
        CAS_VALIDATE_URL: CAS ticket validation URL
        CAS_LOGOUT_URL: CAS logout URL
        CAS_SERVICE_URL: Callback URL for CAS authentication
        CAS_EMAIL_DOMAIN: Email domain suffix (default: si-tech.com.cn)
        CAS_DISPLAY_NAME: Display name on login button (default: 易信登录)

    Returns:
        CASConfig instance with values from config/env or defaults
    """
    cfg = CASConfig()

    try:
        from deerflow.config.app_config import get_app_config  # 延迟导入，避免循环

        cas = get_app_config().auth.cas
    except (FileNotFoundError, AttributeError):
        cas = None

    if cas is not None:
        cfg.enabled = bool(cas.enabled)
        cfg.display_name = cas.display_name or cfg.display_name
        cfg.login_url = cas.login_url or cfg.login_url
        cfg.validate_url = cas.validate_url or cfg.validate_url
        cfg.logout_url = cas.logout_url or cfg.logout_url
        cfg.service_url = cas.service_url or cfg.service_url
        cfg.email_domain = cas.email_domain or cfg.email_domain

    env_enabled = os.getenv("CAS_ENABLED")
    if env_enabled is not None:
        cfg.enabled = env_enabled.strip().lower() in {"1", "true", "yes", "on"}
    cfg.display_name = os.getenv("CAS_DISPLAY_NAME", cfg.display_name)
    cfg.login_url = os.getenv("CAS_LOGIN_URL", cfg.login_url)
    cfg.validate_url = os.getenv("CAS_VALIDATE_URL", cfg.validate_url)
    cfg.logout_url = os.getenv("CAS_LOGOUT_URL", cfg.logout_url)
    cfg.service_url = os.getenv("CAS_SERVICE_URL", cfg.service_url)
    cfg.email_domain = os.getenv("CAS_EMAIL_DOMAIN", cfg.email_domain)
    return cfg


def is_cas_enabled() -> bool:
    """Check if CAS SSO is enabled."""
    return get_cas_config().enabled


def get_cas_provider_info() -> dict | None:
    """Get CAS provider info for the /providers endpoint.

    Returns:
        Provider dict if CAS is enabled, None otherwise
    """
    if not is_cas_enabled():
        return None

    config = get_cas_config()
    return {
        "id": "yixin",
        "display_name": config.display_name,
        "type": "cas",
    }