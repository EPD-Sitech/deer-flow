"""Transit / oncon configuration helpers.

Reads the ``oncon`` and ``transit`` sections from ``config.yaml``. Both are
extra sections preserved via ``AppConfig.model_config = ConfigDict(extra="allow")``
(``model_extra``), mirroring how ``channels`` is read in the channel-connections
router. No schema/``config_version`` change is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from deerflow.config.app_config import AppConfig, get_app_config


@dataclass
class OnconAppConfig:
    """易信易token 应用配置（config.yaml -> oncon.app）。"""

    appid: str = ""
    secret: str = ""
    baseurl: str = ""
    resource: str = ""


@dataclass
class TransitConfig:
    """oneai 中转站配置（config.yaml -> transit）。"""

    base_url: str = "https://oneai.teamshub.com/v1"
    # Per-model capability overrides matched by id glob (fnmatch). Used to attach
    # supports_thinking / when_thinking_* to the dynamic oneai catalog so the
    # 闪速/思考/pro mode stack actually takes effect (see runtime/transit.py).
    model_profiles: list[dict] = field(default_factory=list)


def _extra_section(config: AppConfig, key: str) -> dict[str, Any]:
    extra = config.model_extra or {}
    section = extra.get(key)
    return dict(section) if isinstance(section, dict) else {}


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def get_oncon_app_config() -> OnconAppConfig:
    """Read ``oncon.app`` from config.yaml (no env override)."""
    section = _extra_section(get_app_config(), "oncon")
    app = section.get("app")
    app_dict = dict(app) if isinstance(app, dict) else {}
    return OnconAppConfig(
        appid=_as_str(app_dict.get("appid")),
        secret=_as_str(app_dict.get("secret")),
        baseurl=_as_str(app_dict.get("baseurl") or app_dict.get("base_url")),
        resource=_as_str(app_dict.get("resource")),
    )


def get_transit_config() -> TransitConfig:
    """Read ``transit`` from config.yaml (no env override)."""
    section = _extra_section(get_app_config(), "transit")
    raw_profiles = section.get("model_profiles")
    profiles = raw_profiles if isinstance(raw_profiles, list) else []
    return TransitConfig(
        base_url=_as_str(section.get("base_url") or section.get("baseurl"))
        or "https://oneai.teamshub.com/v1",
        model_profiles=profiles,
    )


def is_yixin_transit_configured() -> bool:
    """True when the oncon appid/secret/baseurl are all present."""
    oncon = get_oncon_app_config()
    return bool(oncon.appid and oncon.secret and oncon.baseurl)
