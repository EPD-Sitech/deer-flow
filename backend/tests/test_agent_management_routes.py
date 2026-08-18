import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.gateway.agent_management import router as extension_router
from app.gateway.agent_management.router import ScheduleConfig, _schedule_to_native, _service
from app.gateway.agent_management.sharing_router import _share_owner, _sharing_error
from app.gateway.auth_middleware import _is_public
from app.gateway.csrf_middleware import should_check_csrf
from deerflow.config.paths import Paths

router_module = importlib.import_module("app.gateway.agent_management.router")
sharing_router_module = importlib.import_module("app.gateway.agent_management.sharing_router")


def test_local_agent_management_routes_are_incremental_and_exclude_other_catalogs() -> None:
    paths = {(route.path, method) for route in extension_router.routes for method in route.methods}

    expected = {
        ("/api/agents/{name}/share", "GET"),
        ("/api/agents/{name}/share", "PUT"),
        ("/api/agent-management/catalog", "GET"),
        ("/api/agent-management/platform/{name}", "DELETE"),
        ("/api/public/agents/{public_name}", "GET"),
        ("/api/public/agents/{public_name}/chat", "POST"),
        ("/api/agents/{name}/validate", "POST"),
        ("/api/agents/{name}/test", "POST"),
        ("/api/agents/{name}/logs", "GET"),
        ("/api/agents/{name}/versions", "GET"),
        ("/api/agents/{name}/versions", "POST"),
        ("/api/agents/{name}/memory", "GET"),
        ("/api/agents/{name}/memory", "PUT"),
        ("/api/agents/{name}/stats", "GET"),
        ("/api/agents/{name}/files", "GET"),
        ("/api/agents/{name}/files", "PUT"),
        ("/api/agents/{name}/settings", "PUT"),
        ("/api/agents/{name}/export", "GET"),
        ("/api/agents/batch/export", "POST"),
        ("/api/agents/import", "POST"),
        ("/api/agents/{name}/clone", "POST"),
        ("/api/agents/batch/delete", "POST"),
        ("/api/agents/{name}/import-sub-agent-package", "POST"),
        ("/api/agents/{agent_name}/schedules", "GET"),
        ("/api/agents/{agent_name}/schedules", "POST"),
    }
    assert expected <= paths
    assert all("knowledge" not in path for path, _ in paths)
    assert all("template" not in path for path, _ in paths)
    assert all("remote" not in path and "a2a" not in path for path, _ in paths)
    assert ("/api/agents", "GET") not in paths
    assert ("/api/agents", "POST") not in paths
    assert ("/api/agents/{name}", "PUT") not in paths
    assert ("/api/agents/{name}", "DELETE") not in paths


def test_public_agent_routes_use_normal_cookie_auth_and_csrf() -> None:
    assert _is_public("/api/public/agents/report-writer") is False
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/public/agents/report-writer/chat",
            "headers": [],
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1234),
            "query_string": b"",
        }
    )
    assert should_check_csrf(request) is True


def test_source_schedule_shapes_map_to_native_scheduler_contract() -> None:
    schedule_type, spec, next_at = _schedule_to_native(ScheduleConfig(type="daily", time="09:30", timezone="Asia/Shanghai"))
    assert schedule_type == "cron"
    assert spec == {"cron": "30 9 * * *"}
    assert next_at is not None

    schedule_type, spec, _ = _schedule_to_native(ScheduleConfig(type="interval", interval_seconds=900))
    assert schedule_type == "cron"
    assert spec == {"cron": "*/15 * * * *"}


def test_public_agent_management_requires_admin_but_read_details_can_opt_out(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(router_module, "get_current_user", lambda: SimpleNamespace(system_role="user"))
    monkeypatch.setattr(router_module, "get_effective_user_id", lambda: "regular-user")
    monkeypatch.setattr(router_module, "get_paths", lambda: Paths(tmp_path))

    with pytest.raises(HTTPException) as exc_info:
        _service("platform")
    assert exc_info.value.status_code == 403

    read_service = _service("platform", require_platform_admin=False)
    assert read_service.user_id == "regular-user"


def test_only_admins_can_manage_public_agent_sharing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sharing_router_module, "get_current_user", lambda: SimpleNamespace(system_role="user"))
    with pytest.raises(HTTPException) as exc_info:
        _share_owner("platform")
    assert exc_info.value.status_code == 403
    assert _sharing_error(exc_info.value).status_code == 403

    monkeypatch.setattr(sharing_router_module, "get_current_user", lambda: SimpleNamespace(system_role="admin"))
    assert _share_owner("platform") == "__platform__"


def test_only_admins_can_share_their_custom_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sharing_router_module, "get_current_user", lambda: SimpleNamespace(system_role="user"))
    monkeypatch.setattr(sharing_router_module, "get_effective_user_id", lambda: "regular-user")
    with pytest.raises(HTTPException) as exc_info:
        _share_owner("user")
    assert exc_info.value.status_code == 403

    monkeypatch.setattr(sharing_router_module, "get_current_user", lambda: SimpleNamespace(system_role="admin"))
    monkeypatch.setattr(sharing_router_module, "get_effective_user_id", lambda: "admin-user")
    assert _share_owner("user") == "admin-user"
