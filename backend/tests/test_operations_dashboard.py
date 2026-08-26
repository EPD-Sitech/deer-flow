from collections import Counter
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.gateway.routers import operations
from app.gateway.routers.operations import (
    OperationsDashboardResponse,
    _bucket_index,
    _cumulative_bucket_series,
    _json_content,
    _operations_usage,
    _percent_change,
    _persist_inventory_snapshot,
    _run_agent_name,
    _skill_name,
    _tool_name,
    _top,
    _validate_dashboard_range,
)
from deerflow.persistence.operation_inventory_snapshots.model import OperationInventorySnapshotRow


def test_operations_bucket_index_supports_local_day_offset():
    start_utc = datetime(2026, 8, 18, 16, tzinfo=UTC)  # 2026-08-19 00:00 at UTC+8
    created = start_utc + timedelta(hours=9, minutes=30)

    assert _bucket_index(created, start_utc=start_utc, tz_offset_minutes=480, hourly=True, bucket_count=24) == 9


def test_operations_bucket_index_rejects_out_of_window_rows():
    start_utc = datetime(2026, 8, 19, tzinfo=UTC)
    created = start_utc - timedelta(seconds=1)

    assert _bucket_index(created, start_utc=start_utc, tz_offset_minutes=0, hourly=False, bucket_count=7) is None


def test_operations_cumulative_bucket_series_preserves_stock_semantics():
    assert _cumulative_bucket_series([0, 2, 0, 1], initial_value=5) == [5, 7, 7, 8]
    assert _cumulative_bucket_series([1, -3, 2]) == [1, 1, 3]


def test_operations_json_content_accepts_serialized_dict_only():
    assert _json_content('{"name":"read_file"}') == {"name": "read_file"}
    assert _json_content("[1,2,3]") == {}
    assert _json_content("not json") == {}


def test_operations_run_agent_name_prefers_expert_context():
    assert _run_agent_name("lead_agent", {"config": {"context": {"agent_name": "researcher"}}}) == "researcher"
    assert _run_agent_name("lead_agent", {"config": {"configurable": {"agent_name": "writer"}}}) == "writer"
    assert _run_agent_name("lead_agent", {}, {"agent_name": "公众号运营智能体"}) == "公众号运营智能体"
    assert _run_agent_name("lead_agent", {}, {}, {"agent_name": "run-snapshot"}) == "run-snapshot"
    assert (
        _run_agent_name(
            "lead_agent",
            {},
            {"agent_name": "agent-15562e852915f2f4"},
            {},
            {"agent-15562e852915f2f4": "公众号运营智能体"},
        )
        == "公众号运营智能体"
    )
    assert _run_agent_name("lead_agent", {}) == "默认智能体"


def test_operations_agent_catalog_prefers_configured_display_name(monkeypatch):
    class FakeCatalog:
        def __init__(self, **_kwargs):
            pass

        def list_agents(self):
            return [
                {
                    "name": "wechat-operator",
                    "runtime_name": "agent-abc123",
                    "display_name": "公众号运营智能体",
                }
            ]

    monkeypatch.setattr(
        "app.gateway.agent_management.catalog.AgentCatalogService",
        FakeCatalog,
    )
    monkeypatch.setattr(
        "deerflow.persistence.agents.get_agent_store",
        lambda: object(),
    )

    _, aliases = operations._agent_catalog("admin", True)

    assert aliases["agent-abc123"] == "公众号运营智能体"
    assert aliases["wechat-operator"] == "公众号运营智能体"


def test_operations_agent_catalog_uses_description_for_runtime_alias(monkeypatch):
    class FakeCatalog:
        def __init__(self, **_kwargs):
            pass

        def list_agents(self):
            return [
                {
                    "name": "agent-2776d1f2c2ef7f60",
                    "runtime_name": "agent-2776d1f2c2ef7f60",
                    "description": "产品经理培训答疑",
                }
            ]

    monkeypatch.setattr(
        "app.gateway.agent_management.catalog.AgentCatalogService",
        FakeCatalog,
    )
    monkeypatch.setattr("deerflow.persistence.agents.get_agent_store", lambda: object())

    _, aliases = operations._agent_catalog("admin", True)

    assert aliases["agent-2776d1f2c2ef7f60"] == "产品经理培训答疑"


def test_operations_event_name_helpers_support_persisted_shapes():
    assert _tool_name({"function": {"name": "read_file"}}, {}) == "read_file"
    assert _tool_name('{"tool_name":"search"}', {}) == "search"
    assert _tool_name({}, {"tool_name": "browser"}) == "browser"
    assert _skill_name({"changes": {"skill_name": "slides"}}, {}) == "slides"
    assert _skill_name({}, {"skill_name": "docs"}) == "docs"
    assert (
        _skill_name(
            {
                "additional_kwargs": {
                    "skill_context_entry": {
                        "path": "/mnt/skills/public/wechat-operations/SKILL.md",
                        "description": "微信公众号运营",
                    }
                }
            },
            {},
        )
        == "wechat-operations"
    )
    assert _skill_name({}, {}) == "unknown"


def test_operations_percent_change_handles_zero_previous_period():
    assert _percent_change(15, 10) == 50.0
    assert _percent_change(3, 0) == 100.0
    assert _percent_change(0, 0) is None


@pytest.mark.asyncio
async def test_operations_inventory_snapshot_persists_and_uses_period_start_baseline(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'operations.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    baseline_at = datetime(2026, 8, 14, tzinfo=UTC)
    captured_at = datetime(2026, 8, 21, 8, tzinfo=UTC)

    try:
        async with engine.begin() as connection:
            await connection.run_sync(OperationInventorySnapshotRow.__table__.create)
        async with session_factory() as session:
            session.add(
                OperationInventorySnapshotRow(
                    total_artifacts=4,
                    total_agents=8,
                    total_skills=20,
                    captured_at=baseline_at - timedelta(hours=1),
                )
            )
            await session.commit()

        comparisons = await _persist_inventory_snapshot(
            session_factory,
            total_artifacts=6,
            total_agents=10,
            total_skills=15,
            baseline_at=baseline_at,
            captured_at=captured_at,
        )

        assert comparisons == {
            "total_artifacts": 50.0,
            "total_agents": 25.0,
            "total_skills": -25.0,
        }
        async with session_factory() as session:
            count = await session.scalar(select(func.count()).select_from(OperationInventorySnapshotRow))
            current = await session.scalar(select(OperationInventorySnapshotRow).where(OperationInventorySnapshotRow.captured_at == captured_at).limit(1))
        assert count == 2
        assert current is not None
        assert current.total_agents == 10
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_operations_inventory_snapshot_returns_empty_comparisons_without_history(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'operations-empty.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    try:
        async with engine.begin() as connection:
            await connection.run_sync(OperationInventorySnapshotRow.__table__.create)

        comparisons = await _persist_inventory_snapshot(
            session_factory,
            total_artifacts=2,
            total_agents=3,
            total_skills=4,
            baseline_at=datetime(2026, 8, 14, tzinfo=UTC),
            captured_at=datetime(2026, 8, 21, tzinfo=UTC),
        )

        assert comparisons == {
            "total_artifacts": None,
            "total_agents": None,
            "total_skills": None,
        }
    finally:
        await engine.dispose()


def test_operations_usage_reads_valid_durable_snapshot():
    usage = _operations_usage(
        {
            "agent_name": "公众号运营智能体",
            "operations_usage": {
                "version": 1,
                "tools": {"read_file": 2, "invalid": 0, "bad": "x"},
                "skills": {"wechat-operations": 1},
            },
        }
    )

    assert usage is not None
    tools, skills = usage
    assert tools == Counter({"read_file": 2})
    assert skills == Counter({"wechat-operations": 1})
    assert _operations_usage({"agent_name": "legacy"}) is None


def test_operations_top_returns_named_metrics_in_descending_order():
    values = _top(Counter({"a": 2, "b": 5, "c": 1}))

    assert [item.name for item in values] == ["b", "a", "c"]
    assert [item.value for item in values] == [5, 2, 1]


def test_operations_dashboard_range_accepts_integer_query_values():
    assert _validate_dashboard_range(1) == 1
    assert _validate_dashboard_range(7) == 7
    assert _validate_dashboard_range(30) == 30
    assert _validate_dashboard_range(90) == 90


def test_operations_dashboard_range_rejects_unknown_values():
    with pytest.raises(HTTPException) as exc_info:
        _validate_dashboard_range(14)

    assert exc_info.value.status_code == 422


def test_operations_dashboard_response_excludes_deferred_statistics():
    deferred_fields = {
        "artifacts_by_type",
        "total_artifacts",
        "total_skills",
        "mcp_total",
        "uploads_total",
    }

    assert "artifacts_by_type" not in OperationsDashboardResponse.model_fields
    assert deferred_fields.isdisjoint(operations.DashboardTotals.model_fields)


def test_operations_skill_counts_use_effective_users_full_catalog(monkeypatch):
    class Skill:
        def __init__(self, category):
            self.category = category

    class Storage:
        def load_skills(self, *, enabled_only):
            assert enabled_only is False
            return [
                Skill("public"),
                Skill("custom"),
                Skill("integration"),
                Skill("legacy"),
            ]

    captured = {}

    def get_user_storage(user_id):
        captured["user_id"] = user_id
        return Storage()

    monkeypatch.setattr(operations, "get_or_new_user_skill_storage", get_user_storage)

    assert operations._skill_counts("admin-1") == (4, 1, 3)
    assert captured["user_id"] == "admin-1"


@pytest.mark.asyncio
async def test_operations_dashboard_details_aggregates_deferred_statistics(monkeypatch):
    thread_rows = [("thread-1", "user-1")]

    class Result:
        def all(self):
            return thread_rows

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def execute(self, statement):
            return Result()

    class SessionFactory:
        def __call__(self):
            return Session()

    async def require_admin(request, *, detail):
        return None

    async def persist_inventory_snapshot(session_factory, **kwargs):
        assert kwargs["total_artifacts"] == 4
        assert kwargs["total_agents"] == 7
        assert kwargs["total_skills"] == 5
        return {
            "total_artifacts": 10.0,
            "total_agents": 20.0,
            "total_skills": 30.0,
        }

    monkeypatch.setattr(operations, "require_admin_user", require_admin)
    monkeypatch.setattr(operations, "_session_factory_or_503", lambda: SessionFactory())
    monkeypatch.setattr(operations, "_scan_thread_files", lambda rows: (4, {".md": 3, ".txt": 1}, 2, 128))
    monkeypatch.setattr(operations, "_skill_counts", lambda user_id: (5, 3, 2))
    monkeypatch.setattr(operations, "_mcp_counts", lambda: (4, 1))
    monkeypatch.setattr(operations, "_agent_count", lambda user_id, can_manage_public: 7)
    monkeypatch.setattr(operations, "_persist_inventory_snapshot", persist_inventory_snapshot)

    response = await operations.operations_dashboard_details(object(), range_days=7, tz_offset_minutes=480)

    assert response.total_artifacts == 4
    assert response.artifacts_by_type == {".md": 3, ".txt": 1}
    assert response.uploads_total == 2
    assert response.uploads_size == 128
    assert response.total_skills == 5
    assert response.public_skills == 3
    assert response.user_skills == 2
    assert response.total_agents == 7
    assert response.mcp_total == 4
    assert response.mcp_enabled == 1
    assert response.knowledge_documents_total == 2
    assert response.comparisons == {
        "total_artifacts": 10.0,
        "total_agents": 20.0,
        "total_skills": 30.0,
    }
