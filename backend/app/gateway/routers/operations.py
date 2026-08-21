"""Platform operations dashboard endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.gateway.deps import require_admin_user
from app.gateway.operation_events import record_operation_event
from app.gateway.routers.console import _build_pricing_map, _pricing_currency, _run_cost
from deerflow.config import get_app_config
from deerflow.config.extensions_config import get_extensions_config
from deerflow.config.paths import get_paths
from deerflow.persistence.engine import get_session_factory
from deerflow.persistence.feedback.model import FeedbackRow
from deerflow.persistence.models.run_event import RunEventRow
from deerflow.persistence.operation_events.model import OperationEventRow
from deerflow.persistence.operation_inventory_snapshots.model import OperationInventorySnapshotRow
from deerflow.persistence.run.model import RunRow
from deerflow.persistence.thread_meta.model import ThreadMetaRow
from deerflow.persistence.user.model import UserRow
from deerflow.runtime.user_context import get_current_user, get_effective_user_id
from deerflow.skills.storage import get_or_new_user_skill_storage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/operations", tags=["operations"])

DashboardRange = Literal[1, 7, 30, 90]
_DASHBOARD_RANGES: set[int] = {1, 7, 30, 90}


class NamedMetric(BaseModel):
    name: str
    value: int | float


class DashboardSeries(BaseModel):
    labels: list[str]
    login_registered: list[int]
    login_guest: list[int]
    sessions_registered: list[int]
    sessions_guest: list[int]
    token_input: list[int]
    token_output: list[int]
    token_total: list[int]
    token_cost: list[float]
    tool_calls: list[int]
    skill_activations: list[int]
    active_users: list[int]


class DashboardTotals(BaseModel):
    registered_users: int
    guest_users: int
    total_users: int
    active_users: int
    total_logins: int
    total_sessions: int
    total_threads: int
    total_tokens: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost: float | None = None
    currency: str | None = None
    total_tool_calls: int
    total_tools: int
    total_skill_activations: int
    configured_models: int
    feedback_total: int


class OperationsDashboardResponse(BaseModel):
    meta: dict[str, Any]
    range: DashboardRange
    totals: DashboardTotals
    series: DashboardSeries
    top_users_login: list[NamedMetric]
    top_users_sessions: list[NamedMetric]
    top_users_tokens: list[NamedMetric]
    top_agents: list[NamedMetric]
    top_tools: list[NamedMetric]
    top_skills: list[NamedMetric]
    models: list[NamedMetric]
    comparisons: dict[str, float | None]
    sources: dict[str, str]


class OperationsDashboardDetailsResponse(BaseModel):
    """Filesystem and extension statistics loaded after the dashboard shell."""

    total_artifacts: int
    artifacts_by_type: dict[str, int]
    total_skills: int
    public_skills: int
    user_skills: int
    total_agents: int
    mcp_total: int
    mcp_enabled: int
    uploads_total: int
    uploads_size: int
    knowledge_bases_total: int = 0
    knowledge_documents_total: int = 0
    comparisons: dict[str, float | None]
    sources: dict[str, str]


class OperationEventCreateRequest(BaseModel):
    event_type: str = Field(..., min_length=1, max_length=64)
    actor_kind: Literal["registered", "guest", "system"] = "registered"
    source: str = Field(default="api", max_length=32)
    metadata: dict[str, Any] = Field(default_factory=dict)


class OperationEventCreateResponse(BaseModel):
    success: bool


def _session_factory_or_503():
    sf = get_session_factory()
    if sf is None:
        raise HTTPException(
            status_code=503,
            detail="Operations dashboard requires a SQL database backend; set database.backend to sqlite or postgres in config.yaml.",
        )
    return sf


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _json_content(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _run_agent_name(
    assistant_id: str | None,
    kwargs_json: Any,
    thread_metadata: Any = None,
    run_metadata: Any = None,
    agent_aliases: dict[str, str] | None = None,
) -> str:
    """Resolve the expert name used by a persisted run.

    Custom experts execute through ``lead_agent`` and carry their real name in
    the runtime context. New runs snapshot it in ``metadata_json``; older rows
    can recover it from the request config or the associated thread metadata.
    ``assistant_id`` is only a fallback for direct custom-assistant callers.
    """
    config = kwargs_json.get("config") if isinstance(kwargs_json, dict) else None
    if isinstance(config, dict):
        for container_name in ("context", "configurable"):
            container = config.get(container_name)
            if isinstance(container, dict):
                agent_name = container.get("agent_name")
                if isinstance(agent_name, str) and agent_name.strip():
                    resolved = agent_name.strip()
                    return (agent_aliases or {}).get(resolved, resolved)
    for metadata in (run_metadata, thread_metadata):
        agent_name = metadata.get("agent_name") if isinstance(metadata, dict) else None
        if isinstance(agent_name, str) and agent_name.strip():
            resolved = agent_name.strip()
            return (agent_aliases or {}).get(resolved, resolved)
    if isinstance(assistant_id, str) and assistant_id.strip() and assistant_id != "lead_agent":
        resolved = assistant_id.strip()
        return (agent_aliases or {}).get(resolved, resolved)
    return "默认智能体"


_TOOL_EVENT_TYPES = {"llm.tool.result", "tool.result"}


def _tool_name(content: Any, metadata: Any) -> str:
    """Extract a tool name from current and legacy persisted event shapes."""
    payload = _json_content(content)
    candidates: list[Any] = [payload.get("name"), payload.get("tool_name")]
    for key in ("function", "tool_call", "additional_kwargs", "response_metadata"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.extend((nested.get("name"), nested.get("tool_name")))
    if isinstance(metadata, dict):
        candidates.extend((metadata.get("name"), metadata.get("tool_name")))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return "unknown"


def _skill_name(content: Any, metadata: Any) -> str:
    """Extract a skill name from activation and skill-file-read payloads."""
    payload = _json_content(content)
    changes = payload.get("changes") if isinstance(payload.get("changes"), dict) else {}
    candidates = [changes.get("skill_name"), payload.get("skill_name")]
    additional_kwargs = payload.get("additional_kwargs")
    if isinstance(additional_kwargs, dict):
        entry = additional_kwargs.get("skill_context_entry")
        if isinstance(entry, dict):
            candidates.extend((entry.get("name"), entry.get("skill_name")))
            path = entry.get("path")
            if isinstance(path, str) and path:
                parts = [part for part in path.rstrip("/").split("/") if part]
                if len(parts) >= 2 and parts[-1].lower() == "skill.md":
                    candidates.append(parts[-2])
    if isinstance(metadata, dict):
        metadata_changes = metadata.get("changes") if isinstance(metadata.get("changes"), dict) else {}
        candidates.extend((metadata_changes.get("skill_name"), metadata.get("skill_name")))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return "unknown"


def _operations_usage(metadata: Any) -> tuple[Counter[str], Counter[str]] | None:
    """Read the durable per-run operations summary from run metadata."""
    if not isinstance(metadata, dict) or "operations_usage" not in metadata:
        return None
    raw_usage = metadata.get("operations_usage")
    if not isinstance(raw_usage, dict):
        return None

    def read_bucket(name: str) -> Counter[str]:
        bucket = raw_usage.get(name)
        result: Counter[str] = Counter()
        if not isinstance(bucket, dict):
            return result
        for raw_name, raw_count in bucket.items():
            if not isinstance(raw_name, str) or not raw_name.strip():
                continue
            try:
                count = int(raw_count)
            except (TypeError, ValueError):
                continue
            if count > 0:
                result[raw_name.strip()] += count
        return result

    return read_bucket("tools"), read_bucket("skills")


def _agent_catalog(user_id: str, can_manage_public: bool) -> tuple[int, dict[str, str]]:
    """Return expert count and runtime-alias-to-display-name mapping."""
    try:
        from app.gateway.agent_management.catalog import AgentCatalogService
        from deerflow.persistence.agents import get_agent_store

        service = AgentCatalogService(
            store=get_agent_store(),
            user_id=user_id,
            paths=get_paths(),
            can_manage_public=can_manage_public,
        )
        agents = service.list_agents()
        aliases: dict[str, str] = {}
        for agent in agents:
            name = agent.get("name")
            runtime_name = agent.get("runtime_name")
            if isinstance(name, str) and name.strip():
                display_name = name.strip()
                aliases[display_name] = display_name
                if isinstance(runtime_name, str) and runtime_name.strip():
                    aliases[runtime_name.strip()] = display_name
        return len(agents), aliases
    except Exception:
        logger.warning("operations dashboard: failed to load agent catalog", exc_info=True)
        return 0, {}


def _agent_count(user_id: str, can_manage_public: bool) -> int:
    """Use the same merged catalog as the expert page for the total."""
    return _agent_catalog(user_id, can_manage_public)[0]


def _display_user(user_id: str | None, emails: dict[str, str]) -> str:
    if not user_id:
        return "访客"
    email = emails.get(user_id)
    if email:
        return email.split("@", 1)[0] or email
    if user_id in {"default", "anonymous", "guest"}:
        return "访客"
    return user_id


def _actor_kind(user_id: str | None) -> str:
    return "guest" if not user_id or user_id in {"default", "anonymous", "guest"} else "registered"


def _top(counter: Counter[str], limit: int = 8) -> list[NamedMetric]:
    return [NamedMetric(name=name, value=value) for name, value in counter.most_common(limit)]


def _validate_dashboard_range(value: int) -> DashboardRange:
    if value not in _DASHBOARD_RANGES:
        raise HTTPException(status_code=422, detail="range must be one of 1, 7, 30, 90.")
    return cast(DashboardRange, value)


def _percent_change(current: int | float, previous: int | float) -> float | None:
    if previous == 0:
        return 100.0 if current else None
    return round((current - previous) / abs(previous) * 100, 1)


async def _persist_inventory_snapshot(
    session_factory: Any,
    *,
    total_artifacts: int,
    total_agents: int,
    total_skills: int,
    baseline_at: datetime,
    captured_at: datetime,
) -> dict[str, float | None]:
    """Store the current inventory and compare it with the period-start baseline."""

    async with session_factory() as session:
        baseline = await session.scalar(
            select(OperationInventorySnapshotRow)
            .where(OperationInventorySnapshotRow.captured_at <= baseline_at)
            .order_by(
                OperationInventorySnapshotRow.captured_at.desc(),
                OperationInventorySnapshotRow.id.desc(),
            )
            .limit(1)
        )
        session.add(
            OperationInventorySnapshotRow(
                total_artifacts=total_artifacts,
                total_agents=total_agents,
                total_skills=total_skills,
                captured_at=captured_at,
            )
        )
        await session.commit()

    if baseline is None:
        return {
            "total_artifacts": None,
            "total_agents": None,
            "total_skills": None,
        }
    return {
        "total_artifacts": _percent_change(total_artifacts, baseline.total_artifacts),
        "total_agents": _percent_change(total_agents, baseline.total_agents),
        "total_skills": _percent_change(total_skills, baseline.total_skills),
    }


def _period_bounds(start_utc: datetime, dashboard_range: DashboardRange) -> tuple[datetime, datetime, datetime]:
    duration = timedelta(days=dashboard_range)
    return start_utc, start_utc + duration, start_utc - duration


def _in_window(created_at: datetime | None, start_utc: datetime, end_utc: datetime) -> bool:
    created = _as_utc(created_at)
    return created is not None and start_utc <= created < end_utc


def _window(range_days: DashboardRange, tz_offset_minutes: int) -> tuple[datetime, list[str], bool, datetime.date]:
    tz_delta = timedelta(minutes=tz_offset_minutes)
    today_local = (datetime.now(UTC) + tz_delta).date()
    if range_days == 1:
        start_utc = datetime.combine(today_local, time.min, tzinfo=UTC) - tz_delta
        labels = [f"{hour}:00" for hour in range(24)]
        return start_utc, labels, True, today_local
    start_local = today_local - timedelta(days=range_days - 1)
    start_utc = datetime.combine(start_local, time.min, tzinfo=UTC) - tz_delta
    labels = []
    for offset in range(range_days):
        day = start_local + timedelta(days=offset)
        labels.append(f"{day.month}/{day.day}")
    return start_utc, labels, False, today_local


def _bucket_index(
    created_at: datetime | None,
    *,
    start_utc: datetime,
    tz_offset_minutes: int,
    hourly: bool,
    bucket_count: int,
) -> int | None:
    created = _as_utc(created_at)
    if created is None or created < start_utc:
        return None
    local_dt = created + timedelta(minutes=tz_offset_minutes)
    if hourly:
        start_local = start_utc + timedelta(minutes=tz_offset_minutes)
        if local_dt.date() != start_local.date():
            return None
        idx = local_dt.hour
    else:
        start_local_date = (start_utc + timedelta(minutes=tz_offset_minutes)).date()
        idx = (local_dt.date() - start_local_date).days
    return idx if 0 <= idx < bucket_count else None


def _scan_thread_files(thread_rows: list[tuple[str, str | None]]) -> tuple[int, dict[str, int], int, int]:
    paths = get_paths()
    artifact_count = 0
    artifact_types: Counter[str] = Counter()
    upload_count = 0
    upload_size = 0
    seen_outputs: set[Path] = set()
    seen_uploads: set[Path] = set()
    for thread_id, user_id in thread_rows:
        for directory, seen, is_upload in (
            (paths.sandbox_outputs_dir(thread_id, user_id=user_id), seen_outputs, False),
            (paths.sandbox_uploads_dir(thread_id, user_id=user_id), seen_uploads, True),
        ):
            if directory in seen or not directory.exists():
                continue
            seen.add(directory)
            for path in directory.rglob("*"):
                if not path.is_file() or path.name.startswith("."):
                    continue
                if is_upload:
                    upload_count += 1
                    try:
                        upload_size += path.stat().st_size
                    except OSError:
                        pass
                else:
                    artifact_count += 1
                    artifact_types[path.suffix.lower() or "(none)"] += 1
    return artifact_count, dict(sorted(artifact_types.items())), upload_count, upload_size


def _skill_counts(user_id: str) -> tuple[int, int, int]:
    try:
        # Match the Skills page inventory: global public/integration skills
        # plus the effective user's custom or legacy skills.
        skills = get_or_new_user_skill_storage(user_id).load_skills(enabled_only=False)
    except Exception:
        logger.warning("operations dashboard: failed to load skill storage", exc_info=True)
        return 0, 0, 0
    public_count = sum(1 for skill in skills if str(getattr(skill, "category", "")) == "public")
    user_count = len(skills) - public_count
    return len(skills), public_count, user_count


def _mcp_counts() -> tuple[int, int]:
    try:
        servers = get_extensions_config().mcp_servers
    except Exception:
        logger.warning("operations dashboard: failed to load MCP config", exc_info=True)
        return 0, 0
    total = len(servers or {})
    enabled = sum(1 for server in (servers or {}).values() if getattr(server, "enabled", False))
    return total, enabled


@router.post("/events", response_model=OperationEventCreateResponse)
async def create_operation_event(request: Request, body: OperationEventCreateRequest) -> OperationEventCreateResponse:
    await require_admin_user(request, detail="Admin privileges required to record operation events.")
    user = getattr(request.state, "user", None)
    await record_operation_event(
        body.event_type,
        user_id=str(user.id) if user is not None and body.actor_kind == "registered" else None,
        actor_kind=body.actor_kind,
        source=body.source,
        metadata=body.metadata,
    )
    return OperationEventCreateResponse(success=True)


@router.get("/dashboard", response_model=OperationsDashboardResponse)
async def operations_dashboard(
    request: Request,
    range_days: int = Query(default=7, alias="range"),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
) -> OperationsDashboardResponse:
    await require_admin_user(request, detail="Admin privileges required to view operations dashboard.")
    dashboard_range = _validate_dashboard_range(range_days)
    sf = _session_factory_or_503()
    start_utc, labels, hourly, today_local = _window(dashboard_range, tz_offset_minutes)
    current_start, current_end, previous_start = _period_bounds(start_utc, dashboard_range)
    bucket_count = len(labels)

    pricing = _build_pricing_map()
    currency = _pricing_currency(pricing)
    effective_user_id = str(get_effective_user_id())
    can_manage_public = getattr(get_current_user(), "system_role", None) == "admin"

    async with sf() as session:
        user_rows = (await session.execute(select(UserRow.id, UserRow.email, UserRow.created_at))).all()
        emails = {str(user_id): email for user_id, email, _ in user_rows}
        registered_users = len(user_rows)
        registered_users_at_previous_start = sum(1 for _, _, created_at in user_rows if _as_utc(created_at) is not None and _as_utc(created_at) < current_start)

        total_threads = await session.scalar(select(func.count()).select_from(ThreadMetaRow)) or 0

        feedback_total = await session.scalar(select(func.count()).select_from(FeedbackRow)) or 0

        all_run_rows = (
            await session.execute(
                select(
                    RunRow.run_id,
                    RunRow.user_id,
                    RunRow.assistant_id,
                    RunRow.kwargs_json,
                    RunRow.metadata_json,
                    RunRow.thread_id,
                    RunRow.model_name,
                    RunRow.total_input_tokens,
                    RunRow.total_output_tokens,
                    RunRow.total_tokens,
                    RunRow.token_usage_by_model,
                    RunRow.created_at,
                ).where(
                    RunRow.operation_kind == "run",
                    RunRow.created_at >= previous_start,
                    RunRow.created_at < current_end,
                )
            )
        ).all()
        thread_ids = {row.thread_id for row in all_run_rows}
        thread_metadata_rows = (await session.execute(select(ThreadMetaRow.thread_id, ThreadMetaRow.metadata_json).where(ThreadMetaRow.thread_id.in_(thread_ids)))).all()
        thread_metadata = {thread_id: metadata for thread_id, metadata in thread_metadata_rows}
        period_run_rows = [row for row in all_run_rows if _in_window(row.created_at, current_start, current_end)]
        previous_run_rows = [row for row in all_run_rows if _in_window(row.created_at, previous_start, current_start)]

        event_rows = (
            await session.execute(
                select(
                    RunEventRow.run_id,
                    RunEventRow.event_type,
                    RunEventRow.content,
                    RunEventRow.event_metadata,
                    RunEventRow.created_at,
                ).where(
                    RunEventRow.created_at >= previous_start,
                    RunEventRow.created_at < current_end,
                )
            )
        ).all()
        period_event_rows = [row for row in event_rows if _in_window(row.created_at, current_start, current_end)]
        previous_event_rows = [row for row in event_rows if _in_window(row.created_at, previous_start, current_start)]
        operation_rows = (
            await session.execute(
                select(
                    OperationEventRow.event_type,
                    OperationEventRow.user_id,
                    OperationEventRow.actor_kind,
                    OperationEventRow.created_at,
                ).where(
                    OperationEventRow.created_at >= previous_start,
                    OperationEventRow.created_at < current_end,
                )
            )
        ).all()
        period_operation_rows = [row for row in operation_rows if _in_window(row.created_at, current_start, current_end)]
        previous_operation_rows = [row for row in operation_rows if _in_window(row.created_at, previous_start, current_start)]

    _, agent_aliases = await asyncio.to_thread(
        _agent_catalog,
        effective_user_id,
        can_manage_public,
    )

    total_cost: float | None = None
    if pricing:
        cost_sum = 0.0
        for row in period_run_rows:
            cost = _run_cost(
                pricing,
                model_name=row.model_name,
                total_input_tokens=row.total_input_tokens,
                total_output_tokens=row.total_output_tokens,
                token_usage_by_model=row.token_usage_by_model,
            )
            if cost is not None:
                cost_sum += cost
        total_cost = round(cost_sum, 6)

    login_registered = [0] * bucket_count
    login_guest = [0] * bucket_count
    sessions_registered = [0] * bucket_count
    sessions_guest = [0] * bucket_count
    token_input = [0] * bucket_count
    token_output = [0] * bucket_count
    token_total = [0] * bucket_count
    token_cost = [0.0] * bucket_count
    tool_calls = [0] * bucket_count
    skill_activations = [0] * bucket_count
    active_users_by_bucket: list[set[str]] = [set() for _ in range(bucket_count)]

    top_user_sessions: Counter[str] = Counter()
    top_user_tokens: Counter[str] = Counter()
    top_agents: Counter[str] = Counter()
    model_tokens: Counter[str] = Counter()

    for row in period_run_rows:
        idx = _bucket_index(row.created_at, start_utc=start_utc, tz_offset_minutes=tz_offset_minutes, hourly=hourly, bucket_count=bucket_count)
        user_name = _display_user(row.user_id, emails)
        top_user_sessions[user_name] += 1
        top_user_tokens[user_name] += int(row.total_tokens or 0)
        top_agents[
            _run_agent_name(
                row.assistant_id,
                row.kwargs_json,
                thread_metadata.get(row.thread_id),
                row.metadata_json,
                agent_aliases,
            )
        ] += 1
        actor = _actor_kind(row.user_id)
        if idx is not None:
            if actor == "guest":
                sessions_guest[idx] += 1
            else:
                sessions_registered[idx] += 1
            token_input[idx] += int(row.total_input_tokens or 0)
            token_output[idx] += int(row.total_output_tokens or 0)
            token_total[idx] += int(row.total_tokens or 0)
            active_users_by_bucket[idx].add(user_name)
            if pricing:
                cost = _run_cost(
                    pricing,
                    model_name=row.model_name,
                    total_input_tokens=row.total_input_tokens,
                    total_output_tokens=row.total_output_tokens,
                    token_usage_by_model=row.token_usage_by_model,
                )
                if cost is not None:
                    token_cost[idx] = round(token_cost[idx] + cost, 6)

        usage_map = row.token_usage_by_model or {}
        if isinstance(usage_map, dict) and usage_map:
            for model, usage in usage_map.items():
                if isinstance(usage, dict):
                    model_tokens[str(model)] += int(usage.get("total_tokens") or 0)
        elif row.model_name:
            model_tokens[row.model_name] += int(row.total_tokens or 0)

    top_tools: Counter[str] = Counter()
    top_skills: Counter[str] = Counter()
    tool_calls_total = 0
    skill_activations_total = 0

    snapshot_run_ids: set[str] = set()
    for row in period_run_rows:
        usage = _operations_usage(row.metadata_json)
        if usage is None:
            continue
        snapshot_run_ids.add(row.run_id)
        usage_tools, usage_skills = usage
        top_tools.update(usage_tools)
        top_skills.update(usage_skills)
        run_tool_calls = sum(usage_tools.values())
        run_skill_activations = sum(usage_skills.values())
        tool_calls_total += run_tool_calls
        skill_activations_total += run_skill_activations
        idx = _bucket_index(row.created_at, start_utc=start_utc, tz_offset_minutes=tz_offset_minutes, hourly=hourly, bucket_count=bucket_count)
        if idx is not None:
            tool_calls[idx] += run_tool_calls
            skill_activations[idx] += run_skill_activations

    for run_id, event_type, content, metadata, created_at in period_event_rows:
        if run_id in snapshot_run_ids:
            continue
        idx = _bucket_index(created_at, start_utc=start_utc, tz_offset_minutes=tz_offset_minutes, hourly=hourly, bucket_count=bucket_count)
        if event_type in _TOOL_EVENT_TYPES:
            tool_name = _tool_name(content, metadata)
            if tool_name != "unknown":
                top_tools[tool_name] += 1
                tool_calls_total += 1
                if idx is not None:
                    tool_calls[idx] += 1
            skill_name = _skill_name(content, metadata)
            if skill_name != "unknown":
                top_skills[skill_name] += 1
                skill_activations_total += 1
                if idx is not None:
                    skill_activations[idx] += 1
        elif event_type == "middleware:skill_activation":
            skill_name = _skill_name(content, metadata)
            if skill_name == "unknown":
                continue
            top_skills[skill_name] += 1
            skill_activations_total += 1
            if idx is not None:
                skill_activations[idx] += 1

    top_user_login: Counter[str] = Counter()
    login_total = 0
    guest_users_in_period: set[str] = set()
    for event_type, user_id, actor_kind, created_at in period_operation_rows:
        if event_type != "login":
            continue
        login_total += 1
        if actor_kind == "guest" and user_id:
            guest_users_in_period.add(str(user_id))
        idx = _bucket_index(created_at, start_utc=start_utc, tz_offset_minutes=tz_offset_minutes, hourly=hourly, bucket_count=bucket_count)
        if idx is not None:
            if actor_kind == "guest":
                login_guest[idx] += 1
            else:
                login_registered[idx] += 1
        top_user_login[_display_user(user_id, emails)] += 1

    def _run_totals(rows: list[Any]) -> tuple[int, int, int, float | None]:
        input_tokens = sum(int(row.total_input_tokens or 0) for row in rows)
        output_tokens = sum(int(row.total_output_tokens or 0) for row in rows)
        tokens = sum(int(row.total_tokens or 0) for row in rows)
        cost = None
        if pricing:
            cost = round(
                sum(
                    _run_cost(
                        pricing,
                        model_name=row.model_name,
                        total_input_tokens=row.total_input_tokens,
                        total_output_tokens=row.total_output_tokens,
                        token_usage_by_model=row.token_usage_by_model,
                    )
                    or 0
                    for row in rows
                ),
                6,
            )
        return input_tokens, output_tokens, tokens, cost

    total_input_tokens, total_output_tokens, total_tokens, total_cost = _run_totals(period_run_rows)
    previous_input_tokens, previous_output_tokens, previous_tokens, previous_cost = _run_totals(previous_run_rows)
    previous_logins = sum(1 for row in previous_operation_rows if row.event_type == "login")
    previous_sessions = len(previous_run_rows)
    previous_snapshot_run_ids: set[str] = set()
    previous_tool_calls = 0
    previous_skill_activations = 0
    for row in previous_run_rows:
        usage = _operations_usage(row.metadata_json)
        if usage is None:
            continue
        previous_snapshot_run_ids.add(row.run_id)
        usage_tools, usage_skills = usage
        previous_tool_calls += sum(usage_tools.values())
        previous_skill_activations += sum(usage_skills.values())
    for run_id, event_type, content, metadata, _ in previous_event_rows:
        if run_id in previous_snapshot_run_ids:
            continue
        if event_type in _TOOL_EVENT_TYPES:
            if _tool_name(content, metadata) != "unknown":
                previous_tool_calls += 1
            if _skill_name(content, metadata) != "unknown":
                previous_skill_activations += 1
        elif event_type == "middleware:skill_activation" and _skill_name(content, metadata) != "unknown":
            previous_skill_activations += 1

    active_user_names = {name for bucket in active_users_by_bucket for name in bucket}
    current_run_count = len(period_run_rows)

    try:
        configured_models = len(get_app_config().models or [])
    except Exception:
        configured_models = 0

    return OperationsDashboardResponse(
        meta={
            "now": datetime.now(UTC).isoformat(),
            "data_until": datetime.now(UTC).isoformat(),
            "local_date": today_local.isoformat(),
            "tz_offset_minutes": tz_offset_minutes,
        },
        range=dashboard_range,
        totals=DashboardTotals(
            registered_users=registered_users,
            guest_users=len(guest_users_in_period),
            total_users=registered_users + len(guest_users_in_period),
            active_users=len(active_user_names),
            total_logins=login_total,
            total_sessions=current_run_count,
            total_threads=int(total_threads),
            total_tokens=int(total_tokens or 0),
            total_input_tokens=int(total_input_tokens or 0),
            total_output_tokens=int(total_output_tokens or 0),
            total_cost=total_cost,
            currency=currency,
            total_tool_calls=tool_calls_total,
            total_tools=len(top_tools),
            total_skill_activations=skill_activations_total,
            configured_models=configured_models,
            feedback_total=int(feedback_total or 0),
        ),
        series=DashboardSeries(
            labels=labels,
            login_registered=login_registered,
            login_guest=login_guest,
            sessions_registered=sessions_registered,
            sessions_guest=sessions_guest,
            token_input=token_input,
            token_output=token_output,
            token_total=token_total,
            token_cost=token_cost,
            tool_calls=tool_calls,
            skill_activations=skill_activations,
            active_users=[len(bucket) for bucket in active_users_by_bucket],
        ),
        top_users_login=_top(top_user_login),
        top_users_sessions=_top(top_user_sessions),
        top_users_tokens=_top(top_user_tokens),
        top_agents=_top(top_agents),
        top_tools=_top(top_tools),
        top_skills=_top(top_skills),
        models=_top(model_tokens),
        comparisons={
            "total_users": _percent_change(
                registered_users + len(guest_users_in_period),
                registered_users_at_previous_start + len({str(row.user_id) for row in previous_operation_rows if row.actor_kind == "guest" and row.user_id}),
            ),
            "total_logins": _percent_change(login_total, previous_logins),
            "total_sessions": _percent_change(current_run_count, previous_sessions),
            "total_artifacts": None,
            "total_agents": None,
            "total_skills": None,
            "total_tokens": _percent_change(total_tokens, previous_tokens),
            "total_cost": _percent_change(total_cost or 0, previous_cost or 0),
            "total_tool_calls": _percent_change(tool_calls_total, previous_tool_calls),
            "total_skill_activations": _percent_change(skill_activations_total, previous_skill_activations),
        },
        sources={
            "logins": "operation_events.login; historical values exist only after this table is deployed",
            "sessions": "runs rows with operation_kind='run'",
            "tokens": "runs token totals and token_usage_by_model",
            "tools": "runs.metadata_json.operations_usage.tools; run_events fallback for legacy runs",
            "skills": "runs.metadata_json.operations_usage.skills; run_events fallback for legacy runs",
        },
    )


@router.get("/dashboard/details", response_model=OperationsDashboardDetailsResponse)
async def operations_dashboard_details(
    request: Request,
    range_days: int = Query(default=7, alias="range"),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
) -> OperationsDashboardDetailsResponse:
    """Load filesystem and extension statistics independently of the dashboard shell."""

    await require_admin_user(request, detail="Admin privileges required to view operations dashboard.")
    dashboard_range = _validate_dashboard_range(range_days)
    start_utc, _, _, _ = _window(dashboard_range, tz_offset_minutes)
    sf = _session_factory_or_503()

    async with sf() as session:
        thread_rows = (await session.execute(select(ThreadMetaRow.thread_id, ThreadMetaRow.user_id))).all()

    effective_user_id = str(get_effective_user_id())
    artifacts_result, skill_result, mcp_result = await asyncio.gather(
        asyncio.to_thread(_scan_thread_files, thread_rows),
        asyncio.to_thread(_skill_counts, effective_user_id),
        asyncio.to_thread(_mcp_counts),
    )
    artifacts_total, artifacts_by_type, uploads_total, uploads_size = artifacts_result
    total_skills, public_skills, user_skills = skill_result
    mcp_total, mcp_enabled = mcp_result
    total_agents = await asyncio.to_thread(
        _agent_count,
        effective_user_id,
        getattr(get_current_user(), "system_role", None) == "admin",
    )
    comparisons = await _persist_inventory_snapshot(
        sf,
        total_artifacts=artifacts_total,
        total_agents=total_agents,
        total_skills=total_skills,
        baseline_at=start_utc,
        captured_at=datetime.now(UTC),
    )

    return OperationsDashboardDetailsResponse(
        total_artifacts=artifacts_total,
        artifacts_by_type=artifacts_by_type,
        total_skills=total_skills,
        public_skills=public_skills,
        user_skills=user_skills,
        total_agents=total_agents,
        mcp_total=mcp_total,
        mcp_enabled=mcp_enabled,
        uploads_total=uploads_total,
        uploads_size=uploads_size,
        knowledge_documents_total=uploads_total,
        comparisons=comparisons,
        sources={
            "artifacts": "thread user-data outputs filesystem scan",
            "uploads": "thread user-data uploads filesystem scan",
            "skills": "skill storage discovery",
            "mcp": "extensions_config.json MCP server configuration",
            "comparisons": "operation_inventory_snapshots nearest at or before the selected period start",
            "knowledge_bases": "not configured; knowledge_documents_total currently mirrors uploads_total",
        },
    )
