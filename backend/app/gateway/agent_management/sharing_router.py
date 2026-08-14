from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.gateway.routers.agents import _require_agents_api_enabled
from deerflow.config.paths import get_paths
from deerflow.models.factory import create_chat_model
from deerflow.persistence.agents import get_agent_store
from deerflow.runtime.user_context import get_current_user, get_effective_user_id

from .guide_questions import guide_questions_from_document, read_raw_config
from .platform_store import PlatformAgentStore
from .service import AgentNotFound
from .sharing import AgentShareRegistry, ShareConflict

logger = logging.getLogger(__name__)
management_router = APIRouter(prefix="/api", tags=["agent-sharing"])
public_router = APIRouter(prefix="/api/public", tags=["public-agents"])


class AgentShareUpdate(BaseModel):
    enabled: bool
    public_slug: str | None = None


class PublicHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class PublicChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    history: list[PublicHistoryMessage] = Field(default_factory=list, max_length=20)


def _registry() -> AgentShareRegistry:
    return AgentShareRegistry(
        store=get_agent_store(),
        platform_store=PlatformAgentStore(get_paths()),
        state_file=get_paths().base_dir / "agent-management" / "public-agent-shares.json",
    )


def _share_owner(scope: Literal["user", "platform"]) -> str:
    if getattr(get_current_user(), "system_role", None) != "admin":
        raise HTTPException(status_code=403, detail="Only administrators can share Agents")
    if scope == "platform":
        return "__platform__"
    return get_effective_user_id()


def _sharing_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, AgentNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ShareConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    logger.exception("Agent sharing operation failed")
    return HTTPException(status_code=500, detail="Agent sharing operation failed")


@management_router.get("/agents/{name}/share")
async def get_agent_share(name: str, scope: Literal["user", "platform"] = "user") -> dict:
    _require_agents_api_enabled()
    try:
        return await asyncio.to_thread(_registry().get, _share_owner(scope), name, scope=scope)
    except Exception as exc:
        raise _sharing_error(exc) from exc


@management_router.put("/agents/{name}/share")
async def update_agent_share(
    name: str,
    body: AgentShareUpdate,
    scope: Literal["user", "platform"] = "user",
) -> dict:
    _require_agents_api_enabled()
    try:
        return await asyncio.to_thread(
            _registry().update,
            _share_owner(scope),
            name,
            enabled=body.enabled,
            public_slug=body.public_slug,
            scope=scope,
        )
    except Exception as exc:
        raise _sharing_error(exc) from exc


def _resolve_or_404(public_name: str) -> dict:
    resolved = _registry().resolve(public_name)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Public Agent not found")
    return resolved


@public_router.get("/agents/{public_name}")
async def get_public_agent(public_name: str) -> dict:
    _require_agents_api_enabled()
    resolved = await asyncio.to_thread(_resolve_or_404, public_name)
    config = resolved["config"]
    registry = _registry()
    store = registry.platform_store if resolved.get("scope") == "platform" else registry.store
    guide_questions = []
    try:
        guide_questions = guide_questions_from_document(
            read_raw_config(store, config.name, resolved.get("owner_id")),
        )
    except (FileNotFoundError, ValueError):
        pass
    return {
        "name": config.name,
        "public_name": resolved["public_name"],
        "description": config.description,
        "tool_groups": config.tool_groups,
        "skills": config.skills,
        "guide_questions": guide_questions,
        "runtime_name": resolved["runtime_name"],
    }


def _chunk_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(block.get("text") or "") for block in content if isinstance(block, dict) and block.get("type") in {"text", "output_text"})
    return ""


@public_router.post("/agents/{public_name}/chat")
async def public_agent_chat(public_name: str, body: PublicChatRequest) -> StreamingResponse:
    _require_agents_api_enabled()
    resolved = await asyncio.to_thread(_resolve_or_404, public_name)
    config = resolved["config"]
    soul = resolved["soul"]
    model_overrides = config.model_settings.model_dump(exclude_none=True) if config.model_settings else None

    async def event_stream():
        try:
            model = await asyncio.to_thread(
                create_chat_model,
                config.model,
                config.thinking_enabled or False,
                model_overrides=model_overrides,
            )
            messages = [SystemMessage(content=soul)] if soul else []
            for item in body.history:
                message_type = HumanMessage if item.role == "user" else AIMessage
                messages.append(message_type(content=item.content))
            messages.append(HumanMessage(content=body.message))

            async for chunk in model.astream(messages):
                if text := _chunk_text(chunk.content):
                    yield f"data: {json.dumps({'type': 'token', 'content': text}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception:
            logger.exception("Public Agent chat failed for '%s'", public_name)
            yield f"data: {json.dumps({'type': 'error', 'detail': 'Public Agent chat failed.'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
