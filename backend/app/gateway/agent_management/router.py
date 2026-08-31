from __future__ import annotations

import asyncio
import io
import logging
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import yaml
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.gateway.deps import (
    get_optional_user_from_request,
    get_run_manager,
    get_run_store,
    get_scheduled_task_repo,
    get_scheduled_task_run_repo,
    get_scheduled_task_service,
    get_thread_store,
)
from app.gateway.routers.agents import (
    AgentResponse,
    AgentUpdateRequest,
    _require_agents_api_enabled,
    _validate_model_exists,
)
from deerflow.agents.lead_agent.prompt import refresh_user_skills_system_prompt_cache_async
from deerflow.agents.memory import get_memory_manager
from deerflow.config.app_config import get_app_config
from deerflow.config.paths import get_paths
from deerflow.config.agents_config import resolve_agent_dir
from deerflow.models.factory import create_chat_model
from deerflow.persistence.agents import AgentExistsError, get_agent_store
from deerflow.runtime.user_context import get_current_user, get_effective_user_id
from deerflow.scheduler.schedules import next_run_at, normalize_cron_expression, validate_timezone
from deerflow.skills.storage import get_or_new_user_skill_storage

from .names import runtime_agent_name
from .platform_db_store import PlatformDbAgentStore
from .platform_metadata import (
    create_platform_agent_metadata,
    get_agent_runtime_owner,
    get_platform_agent_display_names,
    get_public_platform_agent_owner,
    move_agent_scope_record,
    update_platform_agent_display_name,
)
from .platform_store import PlatformAgentStore
from .service import AgentManagementService, AgentNotFound, InvalidAgentArchive, normalize_agent_name

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["agent-management"])


AgentScope = Literal["user", "platform"]


def _platform_store() -> Any:
    app_config = get_app_config()
    if app_config.agent_storage.backend == "db":
        return PlatformDbAgentStore(get_agent_store())
    return PlatformAgentStore(get_paths())


def _agent_storage_backend() -> str:
    return get_app_config().agent_storage.backend


def _service(scope: AgentScope = "user", *, require_platform_admin: bool = True) -> AgentManagementService:
    user_id = get_effective_user_id()
    is_admin = getattr(get_current_user(), "system_role", None) == "admin"
    if scope == "platform":
        if require_platform_admin and not is_admin:
            raise HTTPException(status_code=403, detail="Only administrators can modify public Agents")
        store = _platform_store()
    else:
        store = get_agent_store()
    return AgentManagementService(
        store=store,
        user_id=user_id,
        state_dir=get_paths().user_dir(user_id),
        can_edit_guide_questions=is_admin,
    )


def _apply_settings_updates(
    source_data: dict[str, Any],
    updates: dict[str, Any],
    *,
    name: str,
    welcome_suggestions: list[dict[str, str]] | None,
    welcome_suggestions_set: bool,
) -> tuple[dict[str, Any], str]:
    config = {key: value for key, value in source_data.items() if key != "soul"}
    config.update(updates)
    if welcome_suggestions_set:
        ui = dict(config.get("ui") or {})
        if welcome_suggestions is None:
            ui.pop("welcome_suggestions", None)
        else:
            ui["welcome_suggestions"] = welcome_suggestions
        if ui:
            config["ui"] = ui
        else:
            config.pop("ui", None)
    config["name"] = name
    return config, source_data.get("soul") or ""


def _move_db_agent_scope(
    name: str,
    *,
    source_scope: AgentScope,
    target_scope: AgentScope,
    source_data: dict[str, Any],
    config: dict[str, Any],
    soul: str,
) -> None:
    current_user_id = get_effective_user_id()
    source_owner = get_public_platform_agent_owner(name) or "default" if source_scope == "platform" else current_user_id
    target_owner = "default" if target_scope == "platform" else current_user_id
    target_visibility = "public" if target_scope == "platform" else "private"
    display_name = get_platform_agent_display_names(source_owner, [name]).get(name)

    if source_owner != target_owner and get_agent_store().exists(name, user_id=target_owner):
        raise HTTPException(
            status_code=409,
            detail=f"Agent '{name}' already exists in the target scope",
        )

    moved = move_agent_scope_record(
        source_owner,
        target_owner,
        name,
        visibility=target_visibility,
        config=config,
        soul=soul,
        display_name=display_name or source_data.get("display_name"),
    )
    if not moved:
        raise AgentNotFound(f"Agent '{name}' not found")


def _agent_response(data: dict[str, Any]) -> AgentResponse:
    return AgentResponse(**{key: value for key, value in data.items() if key in AgentResponse.model_fields})


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, AgentNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, AgentExistsError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, (InvalidAgentArchive, ValueError)):
        return HTTPException(status_code=422, detail=str(exc))
    logger.exception("Local-agent management operation failed")
    return HTTPException(status_code=500, detail=str(exc))


def _attachment_header(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "agent-export"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _avatar_dir(name: str, scope: AgentScope) -> Path:
    paths = get_paths()
    normalized = normalize_agent_name(name)
    if scope == "platform":
        return paths.agent_dir(normalized)
    return resolve_agent_dir(normalized, user_id=get_effective_user_id())


@router.get("/agents/{name}/avatar")
async def get_agent_avatar(name: str, scope: AgentScope = "user") -> Response:
    _require_agents_api_enabled()
    try:
        if scope == "platform":
            _service(scope, require_platform_admin=False).describe(name)
        else:
            _service(scope, require_platform_admin=False).describe(name)
        avatar = _avatar_dir(name, scope) / "avatar.png"
        if not avatar.is_file():
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        type_file = avatar.with_name(".avatar-type")
        media_type = type_file.read_text(encoding="ascii").strip() if type_file.is_file() else "image/png"
        return FileResponse(avatar, media_type=media_type, headers={"Cache-Control": "no-cache"})
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/avatar")
async def upload_agent_avatar(
    name: str,
    file: UploadFile = File(...),
    scope: AgentScope = "user",
) -> dict[str, str]:
    _require_agents_api_enabled()
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=422, detail="Avatar must be PNG, JPEG, or WebP")
    try:
        _service(scope).describe(name)
        content = await file.read(5 * 1024 * 1024 + 1)
        if len(content) > 5 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Avatar must be no larger than 5MB")
        directory = _avatar_dir(name, scope)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f".avatar.{uuid.uuid4().hex}.tmp"
        temporary.write_bytes(content)
        temporary.replace(directory / "avatar.png")
        directory.joinpath(".avatar-type").write_text(file.content_type, encoding="ascii")
        return {"avatar_url": f"/api/agents/{normalize_agent_name(name)}/avatar?scope={scope}"}
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_error(exc) from exc


class AgentSettingsWelcomeSuggestion(BaseModel):
    label: str = Field(min_length=1, max_length=24)
    prompt: str = Field(min_length=1, max_length=2000)
    icon: Literal[
        "sparkles",
        "pen",
        "microscope",
        "shapes",
        "graduation-cap",
        "lightbulb",
    ] = "lightbulb"


class AgentSettingsUpdateRequest(AgentUpdateRequest):
    scope: AgentScope | None = Field(
        default=None,
        description="Target Agent scope for management settings",
    )
    welcome_suggestions: list[AgentSettingsWelcomeSuggestion] | None = Field(
        default=None,
        max_length=6,
        description="Agent-specific welcome shortcuts; [] hides them, null/missing uses defaults",
    )


class TestAgentRequest(BaseModel):
    test_prompt: str = Field(default="请介绍你自己", min_length=1)
    max_tokens: int = Field(default=500, ge=1, le=4096)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)


class CreateVersionRequest(BaseModel):
    message: str = ""


class MemoryUpdateRequest(BaseModel):
    memory: dict[str, Any]


class AgentFilesUpdateRequest(BaseModel):
    config_yaml: str | None = None
    soul: str | None = None
    guide_questions: list[dict[str, str]] | None = None
    welcome_suggestions: list[dict[str, str]] | None = None


class AgentDisplayNameUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=128)


class AgentCloneRequest(BaseModel):
    new_name: str
    scope: Literal["user"] = "user"


class AgentNamesRequest(BaseModel):
    agent_names: list[str] = Field(min_length=1, max_length=50)
    scope: AgentScope = "user"


@router.get("/agents/{name}/files")
async def get_agent_files(name: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        data = await asyncio.to_thread(
            _service(scope, require_platform_admin=False).describe,
            name,
        )
        config = {key: value for key, value in data.items() if key != "soul"}
        return {
            "name": data["name"],
            "config_yaml": yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
            "soul": data.get("soul") or "",
            "guide_questions": data.get("ui", {}).get("guide_questions", []),
            "welcome_suggestions": data.get("ui", {}).get("welcome_suggestions"),
        }
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/validate")
async def validate_agent(name: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        return await asyncio.to_thread(_service(scope).validate_agent, name)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/test")
async def test_agent(name: str, body: TestAgentRequest, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        data = await asyncio.to_thread(_service(scope).describe, name)
        model_name = data.get("model")
        model = await asyncio.to_thread(
            create_chat_model,
            model_name,
            model_overrides={"temperature": body.temperature, "max_tokens": body.max_tokens},
        )
        messages = []
        if data.get("soul"):
            messages.append(SystemMessage(content=data["soul"]))
        messages.append(HumanMessage(content=body.test_prompt))
        started = time.monotonic()
        result = await model.ainvoke(messages)
        usage = getattr(result, "usage_metadata", None) or {}
        return {
            "agent_name": normalize_agent_name(name),
            "prompt": body.test_prompt,
            "response": getattr(result, "content", str(result)),
            "metadata": {
                "model_used": model_name or "default",
                "tokens_used": usage.get("total_tokens", 0),
                "latency_ms": int((time.monotonic() - started) * 1000),
                "tools_available": data.get("tool_groups") or [],
                "soul_injected": bool(data.get("soul")),
            },
        }
    except Exception as exc:
        raise _http_error(exc) from exc


async def _agent_runs(name: str, request: Request, limit: int, scope: AgentScope) -> list[dict[str, Any]]:
    normalized = normalize_agent_name(name)
    await asyncio.to_thread(_service(scope).describe, normalized)
    assistant_name = runtime_agent_name(normalized) if scope == "platform" else normalized
    user_id = get_effective_user_id()
    threads = await get_thread_store(request).search(user_id=user_id, limit=500)
    matching = [thread for thread in threads if str(thread.get("assistant_id") or "").lower().replace("_", "-") == assistant_name]
    run_store = get_run_store(request)
    runs: list[dict[str, Any]] = []
    for thread in matching:
        runs.extend(await run_store.list_by_thread(thread["thread_id"], user_id=user_id, limit=limit))
    runs.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return runs[:limit]


def _run_latency_ms(run: dict[str, Any]) -> int:
    try:
        created = datetime.fromisoformat(str(run["created_at"]))
        updated = datetime.fromisoformat(str(run["updated_at"]))
        return max(0, int((updated - created).total_seconds() * 1000))
    except (KeyError, TypeError, ValueError):
        return 0


@router.get("/agents/{name}/logs")
async def get_agent_logs(
    name: str,
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    scope: AgentScope = "user",
) -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        runs = await _agent_runs(name, request, limit, scope)
        return {
            "logs": [
                {
                    "timestamp": run.get("created_at"),
                    "thread_id": run.get("thread_id", ""),
                    "user_query": (run.get("first_human_message") or "")[:200],
                    "response_summary": (run.get("last_ai_message") or "")[:200],
                    "tokens_used": run.get("total_tokens", 0),
                    "latency_ms": _run_latency_ms(run),
                    "status": run.get("status", "unknown"),
                    "run_id": run.get("run_id"),
                    "error": run.get("error"),
                }
                for run in runs
            ]
        }
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/agents/{name}/stats")
async def get_agent_stats(name: str, request: Request, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        runs = await _agent_runs(name, request, 500, scope)
        successful = sum(run.get("status") == "success" for run in runs)
        return {
            "agent_name": normalize_agent_name(name),
            "total_calls": len(runs),
            "success_count": successful,
            "error_count": sum(run.get("status") in {"error", "failed"} for run in runs),
            "avg_latency_ms": int(sum(_run_latency_ms(run) for run in runs) / len(runs)) if runs else 0,
            "total_tokens": sum(int(run.get("total_tokens") or 0) for run in runs),
        }
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/agents/{name}/versions")
async def list_agent_versions(name: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        return {"versions": await asyncio.to_thread(_service(scope).list_versions, name)}
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/versions", status_code=201)
async def create_agent_version(name: str, body: CreateVersionRequest, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        return await asyncio.to_thread(_service(scope).create_version, name, body.message)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/agents/{name}/versions/{version_id}")
async def get_agent_version(name: str, version_id: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        version = await asyncio.to_thread(_service(scope).get_version, name, version_id)
        if version is None:
            raise AgentNotFound(f"Version '{version_id}' not found")
        return version
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/versions/{version_id}/restore")
async def restore_agent_version(name: str, version_id: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        return await asyncio.to_thread(_service(scope).restore_version, name, version_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/agents/{name}/memory")
async def get_agent_memory(name: str, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        normalized = normalize_agent_name(name)
        await asyncio.to_thread(_service(scope).describe, normalized)
        memory_name = runtime_agent_name(normalized) if scope == "platform" else normalized
        manager = await asyncio.to_thread(get_memory_manager)
        memory = await asyncio.to_thread(manager.get_memory, user_id=get_effective_user_id(), agent_name=memory_name)
        return {"memory": memory}
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail="The configured memory backend does not support memory reads") from exc
    except Exception as exc:
        raise _http_error(exc) from exc


@router.put("/agents/{name}/memory")
async def update_agent_memory(name: str, body: MemoryUpdateRequest, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        normalized = normalize_agent_name(name)
        await asyncio.to_thread(_service(scope).describe, normalized)
        memory_name = runtime_agent_name(normalized) if scope == "platform" else normalized
        manager = await asyncio.to_thread(get_memory_manager)
        memory = await asyncio.to_thread(manager.import_memory, body.memory, user_id=get_effective_user_id(), agent_name=memory_name)
        return {"ok": True, "memory": memory}
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail="The configured memory backend does not support memory import") from exc
    except Exception as exc:
        raise _http_error(exc) from exc


@router.put("/agents/{name}/files")
async def update_agent_files(name: str, body: AgentFilesUpdateRequest, scope: AgentScope = "user") -> dict[str, Any]:
    _require_agents_api_enabled()
    try:
        data = await asyncio.to_thread(
            _service(scope).update_files,
            name,
            config_yaml=body.config_yaml,
            soul=body.soul,
            guide_questions=body.guide_questions,
            welcome_suggestions=body.welcome_suggestions if "welcome_suggestions" in body.model_fields_set else None,
            update_welcome_suggestions="welcome_suggestions" in body.model_fields_set,
        )
        config = {key: value for key, value in data.items() if key != "soul"}
        return {
            **data,
            "config_yaml": yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
            "guide_questions": data.get("ui", {}).get("guide_questions", []),
            "welcome_suggestions": data.get("ui", {}).get("welcome_suggestions"),
            "scope": scope,
            "owner_id": get_effective_user_id(),
            "can_manage": True,
        }
    except Exception as exc:
        raise _http_error(exc) from exc


@router.put("/agents/{name}/display-name")
async def update_agent_display_name(
    name: str,
    body: AgentDisplayNameUpdateRequest,
    scope: AgentScope = "user",
) -> dict[str, str]:
    _require_agents_api_enabled()
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=422, detail="Display name cannot be empty")
    try:
        normalized = normalize_agent_name(name)
        owner_id = get_effective_user_id()
        if scope == "platform":
            owner_id = get_public_platform_agent_owner(normalized) or get_agent_runtime_owner(normalized) or "default"
        try:
            await asyncio.to_thread(_service(scope).describe, normalized)
        except AgentNotFound:
            if _agent_storage_backend() != "db":
                raise
            runtime_store = get_agent_store()
            await asyncio.to_thread(runtime_store.get, normalized, user_id=owner_id)
        updated = await asyncio.to_thread(
            update_platform_agent_display_name,
            owner_id,
            normalized,
            display_name,
        )
        if not updated:
            if _agent_storage_backend() != "db":
                raise AgentNotFound(f"Platform metadata for Agent '{normalized}' not found")
            await asyncio.to_thread(
                create_platform_agent_metadata,
                owner_id,
                normalized,
                display_name,
                visibility="public" if scope == "platform" else "private",
            )
        return {"name": normalized, "display_name": display_name}
    except Exception as exc:
        raise _http_error(exc) from exc


@router.put("/agents/{name}/settings")
async def update_agent_settings(
    name: str,
    body: AgentSettingsUpdateRequest,
    scope: AgentScope = "user",
) -> AgentResponse:
    """Update structured agent settings in either the user or platform store."""
    _require_agents_api_enabled()
    if "model" in body.model_fields_set:
        _validate_model_exists(body.model)
    target_scope: AgentScope = body.scope or scope
    welcome_suggestions_set = "welcome_suggestions" in body.model_fields_set
    welcome_suggestions = [item.model_dump() for item in body.welcome_suggestions] if body.welcome_suggestions is not None else None
    updates = body.model_dump(exclude_unset=True)
    updates.pop("scope", None)
    updates.pop("welcome_suggestions", None)
    try:
        if target_scope != scope:
            if getattr(get_current_user(), "system_role", None) != "admin":
                raise HTTPException(status_code=403, detail="Only administrators can change Agent scope")

            source_service = _service(scope, require_platform_admin=False)
            source_data = await asyncio.to_thread(source_service.describe, name)
            config, soul = _apply_settings_updates(
                source_data,
                updates,
                name=name,
                welcome_suggestions=welcome_suggestions,
                welcome_suggestions_set=welcome_suggestions_set,
            )
            if _agent_storage_backend() == "db":
                await asyncio.to_thread(
                    _move_db_agent_scope,
                    name,
                    source_scope=scope,
                    target_scope=target_scope,
                    source_data=source_data,
                    config=config,
                    soul=soul,
                )
            else:
                paths = get_paths()
                target_dir = paths.agent_dir(name) if target_scope == "platform" else paths.user_agent_dir(get_effective_user_id(), name)
                if target_dir.exists():
                    raise HTTPException(
                        status_code=409,
                        detail=f"Agent '{name}' already exists in the target scope",
                    )

                target_store = _platform_store() if target_scope == "platform" else get_agent_store()
                target_write = target_store.create if target_scope == "platform" else target_store.update
                await asyncio.to_thread(
                    target_write,
                    name,
                    config,
                    soul,
                    user_id=get_effective_user_id(),
                )
                source_avatar = _avatar_dir(name, scope) / "avatar.png"
                target_avatar = _avatar_dir(name, target_scope) / "avatar.png"
                if source_avatar.is_file():
                    shutil.copyfile(source_avatar, target_avatar)
                    source_type = source_avatar.with_name(".avatar-type")
                    if source_type.is_file():
                        shutil.copyfile(source_type, target_avatar.with_name(".avatar-type"))
                await asyncio.to_thread(
                    _service(scope, require_platform_admin=False).store.delete,
                    name,
                    user_id=get_effective_user_id(),
                )
            data = await asyncio.to_thread(
                _service(target_scope, require_platform_admin=False).describe,
                name,
            )
        else:
            data = await asyncio.to_thread(
                _service(scope).update_settings,
                name,
                updates,
                welcome_suggestions=welcome_suggestions,
                update_welcome_suggestions=welcome_suggestions_set,
            )
        return _agent_response(data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/agents/{name}/export")
async def export_agent(
    name: str,
    format: Literal["zip", "md"] = "zip",
    scope: AgentScope = "user",
) -> StreamingResponse:
    _require_agents_api_enabled()
    try:
        archive = await asyncio.to_thread(_service(scope).export_agent, name, format=format)
        return StreamingResponse(io.BytesIO(archive.content), media_type=archive.media_type, headers={"Content-Disposition": _attachment_header(archive.filename)})
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/batch/export")
async def batch_export_agents(body: AgentNamesRequest) -> StreamingResponse:
    _require_agents_api_enabled()
    archive = await asyncio.to_thread(_service(body.scope).batch_export, body.agent_names)
    return StreamingResponse(io.BytesIO(archive.content), media_type=archive.media_type, headers={"Content-Disposition": _attachment_header(archive.filename)})


@router.post("/agents/import", status_code=201)
async def import_agent(file: UploadFile = File(...), name_override: str = Form(default=""), scope: Literal["user"] = Form(default="user"), overwrite: bool = Form(default=False)) -> dict[str, Any]:
    _require_agents_api_enabled()
    del scope
    try:
        content = await file.read()
        result = await asyncio.to_thread(_service().import_agent, content, filename=file.filename or "", name_override=name_override, overwrite=overwrite)
        return {"imported": result.imported, "errors": result.errors}
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/{name}/clone", response_model=AgentResponse, status_code=201)
async def clone_agent(name: str, body: AgentCloneRequest, scope: AgentScope = "user") -> AgentResponse:
    _require_agents_api_enabled()
    try:
        source_service = _service(scope)
        await asyncio.to_thread(
            source_service.clone_agent,
            name,
            body.new_name,
            destination_store=get_agent_store() if scope == "platform" else None,
            destination_user_id=get_effective_user_id(),
        )
        return _agent_response(await asyncio.to_thread(_service().describe, body.new_name))
    except Exception as exc:
        raise _http_error(exc) from exc


@router.delete("/agent-management/platform/{name}")
async def delete_platform_agent(name: str) -> dict[str, bool]:
    _require_agents_api_enabled()
    try:
        outcome = await asyncio.to_thread(_service("platform").store.delete, normalize_agent_name(name), user_id=None)
        if outcome != "deleted":
            raise AgentNotFound(f"Agent '{name}' not found")
        return {"success": True}
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/agents/batch/delete")
async def batch_delete_agents(body: AgentNamesRequest) -> dict[str, Any]:
    _require_agents_api_enabled()
    result = await asyncio.to_thread(_service(body.scope).batch_delete, body.agent_names)
    return {"deleted": result.deleted, "errors": result.errors}


def _prepare_subagent_package(content: bytes, work_dir: Path) -> tuple[list[Path], list[tuple[str, str]]]:
    if len(content) > 20 * 1024 * 1024:
        raise InvalidAgentArchive("sub-agent package exceeds 20 MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise InvalidAgentArchive("invalid ZIP archive") from exc
    extract_dir = work_dir / "extracted"
    extract_dir.mkdir(parents=True)
    with archive:
        for item in archive.infolist():
            path = Path(item.filename)
            if item.filename.startswith(("/", "\\")) or ".." in path.parts:
                raise InvalidAgentArchive(f"unsafe archive path: {item.filename}")
        archive.extractall(extract_dir)
    package_root = extract_dir
    candidates = [item for item in extract_dir.iterdir() if item.is_dir() and not item.name.startswith("__MACOSX")]
    if not (package_root / "skill").is_dir() and not (package_root / "agent").is_dir():
        package_root = next((item for item in candidates if (item / "skill").is_dir() or (item / "agent").is_dir()), package_root)
    if not (package_root / "skill").is_dir() and not (package_root / "agent").is_dir():
        raise InvalidAgentArchive("package must contain a skill/ or agent/ directory")

    skill_archives: list[Path] = []
    skill_root = package_root / "skill"
    if skill_root.is_dir():
        for skill_dir in sorted(skill_root.iterdir()):
            if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").is_file():
                continue
            target = work_dir / f"{skill_dir.name}.skill"
            with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as skill_archive:
                for file_path in skill_dir.rglob("*"):
                    if file_path.is_file():
                        skill_archive.write(file_path, f"{skill_dir.name}/{file_path.relative_to(skill_dir)}")
            skill_archives.append(target)

    blocks: list[tuple[str, str]] = []
    agent_root = package_root / "agent"
    if agent_root.is_dir():
        for markdown in sorted(agent_root.glob("*.md")):
            content_text = markdown.read_text(encoding="utf-8")
            match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content_text, re.DOTALL)
            if not match:
                continue
            frontmatter = yaml.safe_load(match.group(1)) or {}
            if not isinstance(frontmatter, dict):
                continue
            title = str(frontmatter.get("name") or markdown.stem).strip()
            body = match.group(2).strip()
            tools = frontmatter.get("tools") or []
            tools_line = f"\n\nTools: {', '.join(str(tool) for tool in tools)}" if tools else ""
            blocks.append((title, f"### {title}\n\n{body}{tools_line}"))
    return skill_archives, blocks


def _replace_sub_agent_block(soul: str, title: str, block: str) -> str | None:
    """Replace an existing ``### <title>`` section of SOUL.md with ``block``.

    Returns the new SOUL.md text, or ``None`` when no section matches ``title``.
    """
    heading = re.search(rf"^###\s+{re.escape(title)}\s*$", soul, re.MULTILINE)
    if heading is None:
        return None
    following = re.search(r"^#{2,3}\s+", soul[heading.end() :], re.MULTILINE)
    end = heading.end() + following.start() if following else len(soul)
    return f"{soul[: heading.start()]}{block}\n\n{soul[end:].lstrip('\n')}"


@router.post("/agents/{name}/import-sub-agent-package")
async def import_sub_agent_package(
    name: str,
    file: UploadFile = File(...),
    scope: AgentScope = "user",
    overwrite: bool = Form(False),
) -> dict[str, Any]:
    """Install a sub-agent ZIP package into an existing agent.

    By default the import is purely additive: skills and sub-agent sections whose
    names already exist are skipped. Pass ``overwrite=true`` to replace them
    in place — that is how a new package version is rolled out.
    """
    _require_agents_api_enabled()
    normalized = normalize_agent_name(name)
    service = _service(scope)
    try:
        agent = await asyncio.to_thread(service.describe, normalized)
        content = await file.read()
        work_dir = Path(await asyncio.to_thread(tempfile.mkdtemp, prefix="deerflow-subagent-"))
        try:
            skill_archives, blocks = await asyncio.to_thread(_prepare_subagent_package, content, work_dir)
            app_config = await asyncio.to_thread(get_app_config)
            storage = await asyncio.to_thread(get_or_new_user_skill_storage, get_effective_user_id(), app_config=app_config)
            installed_skills: list[str] = []
            updated_skills: list[str] = []
            skipped_skills: list[str] = []
            errors: list[dict[str, str]] = []
            for skill_archive in skill_archives:
                try:
                    result = await storage.ainstall_skill_from_archive(skill_archive, overwrite=overwrite)
                    skill_name = str(result["skill_name"])
                    if result.get("updated"):
                        updated_skills.append(skill_name)
                    else:
                        installed_skills.append(skill_name)
                except Exception as exc:
                    if type(exc).__name__ == "SkillAlreadyExistsError":
                        skipped_skills.append(skill_archive.stem)
                    else:
                        errors.append({"name": skill_archive.stem, "error": str(exc)})

            soul = str(agent.get("soul") or "")
            merged_sub_agents: list[str] = []
            updated_sub_agents: list[str] = []
            skipped_sub_agents: list[str] = []
            new_blocks: list[str] = []
            for title, block in blocks:
                if overwrite:
                    replaced = _replace_sub_agent_block(soul, title, block)
                    if replaced is not None:
                        soul = replaced
                        updated_sub_agents.append(title)
                        continue
                if re.search(rf"^###\s+{re.escape(title)}\s*$", soul, re.MULTILINE):
                    skipped_sub_agents.append(title)
                else:
                    merged_sub_agents.append(title)
                    new_blocks.append(block)
            if new_blocks:
                section = "\n\n## Sub-Agents\n\n" if not re.search(r"^##\s+(?:Sub-Agents|子智能体定义)\s*$", soul, re.MULTILINE) else "\n\n"
                soul = f"{soul.rstrip()}{section}{'\n\n'.join(new_blocks)}\n"

            config = {key: value for key, value in agent.items() if key not in {"soul"}}
            if config.get("skills") is not None:
                config["skills"] = list(dict.fromkeys([*config.get("skills", []), *installed_skills, *updated_skills, *skipped_skills]))
            config_yaml = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
            soul_changed = bool(new_blocks or updated_sub_agents)
            skills_changed = bool(config.get("skills") is not None and (installed_skills or updated_skills or skipped_skills))
            if soul_changed or skills_changed:
                await asyncio.to_thread(service.update_files, normalized, config_yaml=config_yaml, soul=soul)
            if installed_skills or updated_skills:
                await refresh_user_skills_system_prompt_cache_async(get_effective_user_id())
            return {
                "success": not errors,
                "installed_skills": installed_skills,
                "updated_skills": updated_skills,
                "skipped_skills": skipped_skills,
                "merged_sub_agents": merged_sub_agents,
                "updated_sub_agents": updated_sub_agents,
                "skipped_sub_agents": skipped_sub_agents,
                "errors": errors,
            }
        finally:
            await asyncio.to_thread(shutil.rmtree, work_dir, True)
    except Exception as exc:
        raise _http_error(exc) from exc


class ScheduleConfig(BaseModel):
    type: Literal["once", "interval", "daily", "weekly", "cron"]
    timezone: str = "Asia/Shanghai"
    run_at: str | None = None
    interval_seconds: int | None = Field(default=None, ge=60)
    time: str | None = None
    days_of_week: list[int] | None = None
    cron_expr: str | None = None
    stagger_seconds: int = 0


class DeliveryConfig(BaseModel):
    mode: Literal["none", "announce", "webhook", "channel"] = "none"
    channel: str | None = None
    webhook_url: str | None = None
    thread_id: str | None = None


class ScheduledJobCreateRequest(BaseModel):
    title: str = Field(default="", max_length=120)
    schedule: ScheduleConfig
    prompt: str = Field(min_length=1, max_length=8000)
    skills: list[str] = Field(default_factory=list, max_length=20)
    tool_groups: list[str] | None = Field(default=None, max_length=20)
    model: str | None = None
    delivery: DeliveryConfig = Field(default_factory=DeliveryConfig)
    enabled: bool = True
    tags: list[str] = Field(default_factory=list, max_length=20)


class ScheduledJobUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    schedule: ScheduleConfig | None = None
    prompt: str | None = Field(default=None, min_length=1, max_length=8000)
    enabled: bool | None = None


def _schedule_to_native(schedule: ScheduleConfig) -> tuple[str, dict[str, Any], datetime | None]:
    validate_timezone(schedule.timezone)
    if schedule.type == "once":
        schedule_type, spec = "once", {"run_at": schedule.run_at}
    elif schedule.type == "cron":
        schedule_type, spec = "cron", {"cron": normalize_cron_expression(schedule.cron_expr or "")}
    elif schedule.type == "interval":
        seconds = schedule.interval_seconds or 0
        if seconds < 60 or seconds % 60:
            raise ValueError("interval_seconds must be a whole number of minutes and at least 60")
        minutes = seconds // 60
        if minutes < 60 and 60 % minutes == 0:
            spec = {"cron": f"*/{minutes} * * * *"}
        elif minutes % 60 == 0 and minutes // 60 <= 23:
            spec = {"cron": f"0 */{minutes // 60} * * *"}
        else:
            raise ValueError("interval_seconds must divide evenly into an hour or be a whole number of hours up to 23")
        schedule_type = "cron"
    elif schedule.type == "daily":
        hour, minute = (schedule.time or "00:00").split(":", 1)
        schedule_type, spec = "cron", {"cron": f"{int(minute)} {int(hour)} * * *"}
    else:
        hour, minute = (schedule.time or "00:00").split(":", 1)
        days = ",".join(str(day) for day in (schedule.days_of_week or []))
        if not days:
            raise ValueError("weekly schedules require days_of_week")
        schedule_type, spec = "cron", {"cron": f"{int(minute)} {int(hour)} * * {days}"}
    computed = next_run_at(schedule_type, spec, schedule.timezone, now=datetime.now(UTC))
    if computed is None:
        raise ValueError("schedule does not have a future run time")
    return schedule_type, spec, computed


async def _schedule_user(request: Request) -> str:
    user = await get_optional_user_from_request(request)
    return str(user.id) if user is not None else get_effective_user_id()


async def _agent_schedule(
    request: Request,
    agent_name: str,
    task_id: str,
    scope: AgentScope = "user",
) -> tuple[str, dict[str, Any]]:
    normalized = normalize_agent_name(agent_name)
    await asyncio.to_thread(_service(scope).describe, normalized)
    assistant_name = runtime_agent_name(normalized) if scope == "platform" else normalized
    user_id = await _schedule_user(request)
    task = await get_scheduled_task_repo(request).get(task_id, user_id=user_id)
    if task is None or str(task.get("assistant_id", "")).lower().replace("_", "-") != assistant_name:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return user_id, task


@router.get("/agents/{agent_name}/schedules")
async def list_agent_schedules(
    agent_name: str,
    request: Request,
    scope: AgentScope = "user",
) -> dict[str, Any]:
    _require_agents_api_enabled()
    normalized = normalize_agent_name(agent_name)
    await asyncio.to_thread(_service(scope).describe, normalized)
    assistant_name = runtime_agent_name(normalized) if scope == "platform" else normalized
    tasks = await get_scheduled_task_repo(request).list_by_user(await _schedule_user(request))
    return {"jobs": [task for task in tasks if str(task.get("assistant_id", "")).lower().replace("_", "-") == assistant_name]}


@router.post("/agents/{agent_name}/schedules", status_code=201)
async def create_agent_schedule(
    agent_name: str,
    body: ScheduledJobCreateRequest,
    request: Request,
    scope: AgentScope = "user",
) -> dict[str, Any]:
    _require_agents_api_enabled()
    normalized = normalize_agent_name(agent_name)
    await asyncio.to_thread(_service(scope).describe, normalized)
    assistant_name = runtime_agent_name(normalized) if scope == "platform" else normalized
    schedule_type, spec, computed = _schedule_to_native(body.schedule)
    task = await get_scheduled_task_repo(request).create(
        task_id=f"task-{uuid.uuid4().hex}",
        user_id=await _schedule_user(request),
        thread_id=body.delivery.thread_id,
        context_mode="reuse_thread" if body.delivery.thread_id else "fresh_thread_per_run",
        assistant_id=assistant_name,
        title=body.title.strip() or f"{normalized} scheduled task",
        prompt=body.prompt.strip(),
        schedule_type=schedule_type,
        schedule_spec=spec,
        timezone=body.schedule.timezone,
        next_run_at=computed if body.enabled else None,
    )
    if not body.enabled:
        task = await get_scheduled_task_repo(request).update(task["id"], user_id=task["user_id"], updates={"status": "paused"})
    return task


@router.put("/agents/{agent_name}/schedules/{job_id}")
async def update_agent_schedule(
    agent_name: str,
    job_id: str,
    body: ScheduledJobUpdateRequest,
    request: Request,
    scope: AgentScope = "user",
) -> dict[str, Any]:
    user_id, existing = await _agent_schedule(request, agent_name, job_id, scope)
    updates = body.model_dump(exclude_none=True, exclude={"schedule", "enabled"})
    if body.schedule is not None:
        schedule_type, spec, computed = _schedule_to_native(body.schedule)
        if schedule_type != existing["schedule_type"]:
            raise HTTPException(status_code=422, detail="Changing schedule type is not supported; recreate the schedule")
        updates.update(schedule_spec=spec, timezone=body.schedule.timezone, next_run_at=computed)
    if body.enabled is not None:
        updates["status"] = "enabled" if body.enabled else "paused"
        if not body.enabled:
            updates["next_run_at"] = None
        elif body.schedule is None:
            updates["next_run_at"] = next_run_at(existing["schedule_type"], existing["schedule_spec"], existing["timezone"], now=datetime.now(UTC))
    updated = await get_scheduled_task_repo(request).update(job_id, user_id=user_id, updates=updates)
    if updated is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return updated


@router.delete("/agents/{agent_name}/schedules/{job_id}")
async def delete_agent_schedule(
    agent_name: str,
    job_id: str,
    request: Request,
    scope: AgentScope = "user",
) -> dict[str, bool]:
    user_id, _ = await _agent_schedule(request, agent_name, job_id, scope)
    return {"success": await get_scheduled_task_repo(request).delete(job_id, user_id=user_id)}


@router.post("/agents/{agent_name}/schedules/{job_id}/trigger")
async def trigger_agent_schedule(
    agent_name: str,
    job_id: str,
    request: Request,
    scope: AgentScope = "user",
) -> dict[str, Any]:
    _, task = await _agent_schedule(request, agent_name, job_id, scope)
    result = await get_scheduled_task_service(request).dispatch_task(task, now=datetime.now(UTC), trigger="manual")
    if result["outcome"] != "launched":
        raise HTTPException(status_code=409 if result["outcome"] == "conflict" else 502, detail=result.get("error") or "Schedule trigger failed")
    return result


@router.get("/agents/{agent_name}/schedules/{job_id}/runs")
async def list_agent_schedule_runs(
    agent_name: str,
    job_id: str,
    request: Request,
    limit: int = Query(default=20, ge=1, le=200),
    scope: AgentScope = "user",
) -> dict[str, Any]:
    await _agent_schedule(request, agent_name, job_id, scope)
    return {"runs": await get_scheduled_task_run_repo(request).list_by_task(job_id, limit=limit)}


@router.post("/agents/{agent_name}/schedules/{job_id}/runs/{scheduled_run_id}/cancel")
async def cancel_agent_schedule_run(
    agent_name: str,
    job_id: str,
    scheduled_run_id: str,
    request: Request,
    scope: AgentScope = "user",
) -> Response:
    await _agent_schedule(request, agent_name, job_id, scope)
    runs = await get_scheduled_task_run_repo(request).list_by_task(job_id, limit=200)
    scheduled_run = next((item for item in runs if item["id"] == scheduled_run_id), None)
    if scheduled_run is None:
        raise HTTPException(status_code=404, detail="Schedule run not found")
    run_id = scheduled_run.get("run_id")
    if not run_id:
        raise HTTPException(status_code=409, detail="Schedule run has not started")
    outcome = await get_run_manager(request).cancel(run_id, action="interrupt")
    if str(outcome) not in {"cancelled", "requested", "taken_over", "CancelOutcome.cancelled", "CancelOutcome.requested", "CancelOutcome.taken_over"}:
        raise HTTPException(status_code=409, detail="Schedule run cannot be cancelled")
    return Response(status_code=202)
