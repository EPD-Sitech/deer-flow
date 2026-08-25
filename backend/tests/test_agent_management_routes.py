import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.gateway.agent_management import router as extension_router
from app.gateway.agent_management.router import (
    AgentDisplayNameUpdateRequest,
    AgentSettingsUpdateRequest,
    ScheduleConfig,
    _schedule_to_native,
    _service,
    update_agent_display_name,
    update_agent_settings,
)
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
        ("/api/agents/{name}/display-name", "PUT"),
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


@pytest.mark.asyncio
async def test_update_platform_display_name_uses_public_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    class FakeService:
        def describe(self, name: str) -> dict:
            return {"name": name}

    monkeypatch.setattr(router_module, "_service", lambda *_args, **_kwargs: FakeService())
    monkeypatch.setattr(router_module, "get_effective_user_id", lambda: "admin-user")
    monkeypatch.setattr(
        router_module,
        "get_public_platform_agent_owner",
        lambda name: "default" if name == "agent-2776d1f2c2ef7f60" else None,
    )

    def fake_update(owner_id: str, name: str, display_name: str) -> bool:
        calls.append((owner_id, name, display_name))
        return True

    monkeypatch.setattr(router_module, "update_platform_agent_display_name", fake_update)
    result = await update_agent_display_name(
        "agent-2776d1f2c2ef7f60",
        AgentDisplayNameUpdateRequest(display_name=" 产品经理培训答疑 "),
        scope="platform",
    )

    assert result == {
        "name": "agent-2776d1f2c2ef7f60",
        "display_name": "产品经理培训答疑",
    }
    assert calls == [("default", "agent-2776d1f2c2ef7f60", "产品经理培训答疑")]


@pytest.mark.asyncio
async def test_db_scope_change_moves_public_agent_to_custom_without_delete(monkeypatch: pytest.MonkeyPatch) -> None:
    name = "agent-c0b2dd0368250d86"
    moves: list[dict] = []

    class FakeStore:
        def exists(self, requested_name: str, *, user_id: str | None = None) -> bool:
            assert requested_name == name
            assert user_id == "admin-user"
            return False

    class FakeService:
        def __init__(self, scope: str) -> None:
            self.scope = scope
            self.store = SimpleNamespace(delete=lambda *_args, **_kwargs: pytest.fail("scope migration must not delete first"))

        def describe(self, requested_name: str) -> dict:
            assert requested_name == name
            if self.scope == "platform":
                return {
                    "name": name,
                    "display_name": "项目-团队流程引擎-t",
                    "description": "企业级项目团队管理全能助手",
                    "skills": ["large-credit-approval"],
                    "soul": "# 项目-团队流程引擎-t SOUL",
                }
            return {
                "name": name,
                "description": "更新后的描述",
                "skills": ["large-credit-approval"],
                "soul": "# 项目-团队流程引擎-t SOUL",
            }

    fake_store = FakeStore()
    monkeypatch.setattr(router_module, "get_current_user", lambda: SimpleNamespace(system_role="admin"))
    monkeypatch.setattr(router_module, "get_effective_user_id", lambda: "admin-user")
    monkeypatch.setattr(router_module, "get_agent_store", lambda: fake_store)
    monkeypatch.setattr(router_module, "_agent_storage_backend", lambda: "db")
    monkeypatch.setattr(router_module, "get_public_platform_agent_owner", lambda requested_name: "default")
    monkeypatch.setattr(router_module, "_service", lambda scope="user", **_kwargs: FakeService(scope))

    def fake_move(from_user_id: str, to_user_id: str, requested_name: str, **kwargs) -> bool:
        moves.append(
            {
                "from_user_id": from_user_id,
                "to_user_id": to_user_id,
                "name": requested_name,
                **kwargs,
            }
        )
        return True

    monkeypatch.setattr(router_module, "move_agent_scope_record", fake_move)

    result = await update_agent_settings(
        name,
        AgentSettingsUpdateRequest(scope="user", description="更新后的描述"),
        scope="platform",
    )

    assert result.name == name
    assert result.description == "更新后的描述"
    assert moves == [
        {
            "from_user_id": "default",
            "to_user_id": "admin-user",
            "name": name,
            "visibility": "private",
            "config": {
                "name": name,
                "display_name": "项目-团队流程引擎-t",
                "description": "更新后的描述",
                "skills": ["large-credit-approval"],
            },
            "soul": "# 项目-团队流程引擎-t SOUL",
            "display_name": "项目-团队流程引擎-t",
        }
    ]


@pytest.mark.asyncio
async def test_db_scope_change_reports_target_conflict_before_move(monkeypatch: pytest.MonkeyPatch) -> None:
    name = "agent-c0b2dd0368250d86"

    class FakeStore:
        def exists(self, requested_name: str, *, user_id: str | None = None) -> bool:
            assert requested_name == name
            assert user_id == "default"
            return True

    class FakeService:
        def describe(self, requested_name: str) -> dict:
            return {"name": requested_name, "description": "自定义智能体", "soul": "# 自定义智能体"}

    monkeypatch.setattr(router_module, "get_current_user", lambda: SimpleNamespace(system_role="admin"))
    monkeypatch.setattr(router_module, "get_effective_user_id", lambda: "admin-user")
    monkeypatch.setattr(router_module, "get_agent_store", lambda: FakeStore())
    monkeypatch.setattr(router_module, "_agent_storage_backend", lambda: "db")
    monkeypatch.setattr(router_module, "_service", lambda *_args, **_kwargs: FakeService())
    monkeypatch.setattr(router_module, "move_agent_scope_record", lambda *_args, **_kwargs: pytest.fail("conflict must be checked before move"))

    with pytest.raises(HTTPException) as exc_info:
        await update_agent_settings(
            name,
            AgentSettingsUpdateRequest(scope="platform"),
            scope="user",
        )

    assert exc_info.value.status_code == 409
