"""Global material center built from thread output files and presented artifacts."""

from __future__ import annotations

import asyncio
import mimetypes
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.gateway.artifact_access import create_artifact_token, verify_artifact_token
from app.gateway.authz import require_permission
from app.gateway.deps import get_run_event_store, get_run_store, get_thread_store
from app.gateway.internal_auth import get_trusted_internal_owner_user_id
from deerflow.config.extensions_config import get_extensions_config
from deerflow.config.paths import get_paths, make_safe_user_id
from deerflow.mcp.cache import get_cached_mcp_tools, reset_mcp_tools_cache
from deerflow.utils.thread_id import ThreadId
from deerflow.workspace_changes.scanner import EXCLUDED_DIR_NAMES, is_sensitive_workspace_path

router = APIRouter(prefix="/api/materials", tags=["materials"])

KNOWLEDGE_SERVERS = ("shopProduct-server", "weknora")
KNOWLEDGE_UPLOAD_TOOL = "create-knowledge-from-url"
KNOWLEDGE_BASE_ID = "5cf6bd7f-6aae-4304-b8a2-a5e289912445"
FAVORITES_KEY = "deerflow_material_favorites"


class MaterialFavoriteRequest(BaseModel):
    favorite: bool


class KnowledgeUploadResponse(BaseModel):
    status: str
    detail: str | None = None
    remote_id: str | None = None


def _owner(request: Request) -> str | None:
    raw = get_trusted_internal_owner_user_id(request)
    if raw:
        return make_safe_user_id(raw)
    user = getattr(request.state, "user", None)
    return make_safe_user_id(str(user.id)) if user is not None else None


def _presented_paths(content: Any) -> list[str]:
    if not isinstance(content, dict):
        return []
    by_tool = content.get("by_tool") or {}
    paths = by_tool.get("present_files")
    if not isinstance(paths, list):
        paths = content.get("presented_paths") or []
    return [p for p in paths if isinstance(p, str) and p.startswith("/mnt/user-data/outputs/")]


def _file_type(name: str, mime: str) -> str:
    suffix_types = {
        ".doc": "doc",
        ".docx": "doc",
        ".odt": "doc",
        ".rtf": "doc",
        ".xls": "sheet",
        ".xlsx": "sheet",
        ".csv": "sheet",
        ".ods": "sheet",
        ".ppt": "slide",
        ".pptx": "slide",
        ".odp": "slide",
        ".pdf": "pdf",
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
        ".gif": "image",
        ".webp": "image",
        ".svg": "image",
        ".mp4": "video",
        ".mov": "video",
        ".webm": "video",
        ".avi": "video",
        ".mp3": "audio",
        ".wav": "audio",
        ".m4a": "audio",
        ".flac": "audio",
        ".md": "md",
        ".markdown": "md",
        ".py": "code",
        ".js": "code",
        ".ts": "code",
        ".tsx": "code",
        ".jsx": "code",
        ".css": "code",
        ".html": "web",
        ".htm": "web",
        ".json": "code",
        ".yaml": "code",
        ".yml": "code",
    }
    suffix = Path(name).suffix.lower()
    if suffix in suffix_types:
        return suffix_types[suffix]
    if mime.startswith("text/"):
        return "other"
    return mime.split("/", 1)[0] if mime.startswith(("image/", "video/", "audio/")) else "other"


def _scan_output_files(outputs_dir: Path) -> list[tuple[str, str]]:
    """Return user-visible files in a thread's outputs directory.

    Output files are eligible even when the Agent forgot to call
    ``present_files``. Internal hidden/transient directories remain excluded.
    """
    if not outputs_dir.is_dir():
        return []
    root = outputs_dir.resolve()
    found: list[tuple[str, str]] = []
    for actual in root.rglob("*"):
        try:
            relative = actual.relative_to(root)
            stat = actual.stat()
        except (OSError, ValueError):
            continue
        if actual.is_symlink() or not actual.is_file() or any(part.startswith(".") or part in EXCLUDED_DIR_NAMES for part in relative.parts):
            continue
        virtual = "/mnt/user-data/outputs/" + relative.as_posix()
        if is_sensitive_workspace_path(virtual):
            continue
        found.append((virtual, datetime.fromtimestamp(stat.st_mtime, UTC).isoformat()))
    return found


async def _collect(request: Request, *, q: str, type_key: str, favorites_only: bool) -> list[dict[str, Any]]:
    thread_store = get_thread_store(request)
    event_store = get_run_event_store(request)
    run_store = get_run_store(request)
    owner = _owner(request)
    threads = await thread_store.search(limit=1000, user_id=owner)
    result: list[dict[str, Any]] = []
    for thread in threads:
        thread_id = str(thread["thread_id"])
        favorite_paths = set((thread.get("metadata") or {}).get(FAVORITES_KEY, []))
        runs = await run_store.list_by_thread(thread_id, user_id=owner, limit=200)
        records: dict[str, tuple[str | None, str]] = {}
        for run in runs:
            run_id = run["run_id"] if isinstance(run, dict) else run.run_id
            try:
                events = await event_store.list_events(
                    thread_id,
                    run_id,
                    event_types=["run.delivery"],
                    limit=4,
                    user_id=owner,
                )
            except TypeError:
                # JSONL and older third-party stores do not yet expose the
                # optional user_id argument; the thread/run stores are still
                # owner-scoped before this fallback is reached.
                events = await event_store.list_events(thread_id, run_id, event_types=["run.delivery"], limit=4)
            for event in events:
                for path in _presented_paths(event.get("content")):
                    records.setdefault(path, (event.get("created_at") or thread.get("updated_at"), run_id))
        for path, updated_at in await asyncio.to_thread(_scan_output_files, get_paths().sandbox_outputs_dir(thread_id, user_id=owner)):
            records.setdefault(path, (updated_at, "outputs"))
        for path, (updated_at, run_id) in records.items():
            name = Path(path).name
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            group = _file_type(name, mime)
            favorite = path in favorite_paths
            if favorites_only and not favorite:
                continue
            haystack = f"{name} {thread.get('display_name') or ''}".lower()
            if q and q.lower() not in haystack:
                continue
            if type_key != "all" and group != type_key:
                continue
            try:
                actual = get_paths().resolve_virtual_path(thread_id, path, user_id=owner)
                stat = await asyncio.to_thread(actual.stat)
                size = stat.st_size
                status = "ready"
            except (FileNotFoundError, OSError, ValueError):
                size = 0
                status = "missing"
            result.append(
                {
                    "id": f"{thread_id}:{path}",
                    "thread_id": thread_id,
                    "thread_title": thread.get("display_name") or "未命名会话",
                    "path": path,
                    "name": name,
                    "type": group,
                    "mime_type": mime,
                    "size": size,
                    "updated_by": getattr(getattr(request.state, "user", None), "email", "当前用户"),
                    "updated_at": updated_at,
                    "favorite": favorite,
                    "status": status,
                    "run_id": run_id,
                    "preview_url": _preview_url(request, thread_id, path, owner),
                }
            )
    result.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return result


@router.get("")
@require_permission("threads", "read")
async def list_materials(
    request: Request,
    q: str = Query(default="", max_length=200),
    type: str = Query(default="all", max_length=20),
    favorites_only: bool = False,
):
    items = await _collect(request, q=q, type_key=type, favorites_only=favorites_only)
    return {"items": items, "total": len(items)}


@router.put("/{thread_id}/favorite")
@require_permission("threads", "write", owner_check=True, require_existing=True)
async def set_favorite(thread_id: ThreadId, request: Request, body: MaterialFavoriteRequest, path: str = Query(...)):
    store = get_thread_store(request)
    thread = await store.get(thread_id, user_id=_owner(request))
    if thread is None or not path.startswith("/mnt/user-data/outputs/"):
        raise HTTPException(status_code=404, detail="Material not found")
    materials = await _collect(request, q="", type_key="all", favorites_only=False)
    if not any(item["thread_id"] == str(thread_id) and item["path"] == path for item in materials):
        raise HTTPException(status_code=404, detail="Material not found")
    metadata = thread.get("metadata") or {}
    favorites = set(metadata.get(FAVORITES_KEY, []))
    if body.favorite:
        favorites.add(path)
    else:
        favorites.discard(path)
    await store.update_metadata(thread_id, {FAVORITES_KEY: sorted(favorites)}, touch=False, user_id=_owner(request))
    return {"favorite": body.favorite}


def _knowledge_tools(tools: list[Any]) -> list[Any]:
    return [tool for tool in tools if (name := getattr(tool, "name", "")) == KNOWLEDGE_UPLOAD_TOOL or name.endswith(f"_{KNOWLEDGE_UPLOAD_TOOL}") or name.endswith(f"-{KNOWLEDGE_UPLOAD_TOOL}")]


def _related_knowledge_tools(tools: list[Any]) -> list[Any]:
    return [tool for tool in tools if any(token in getattr(tool, "name", "").lower() for token in ("weknora", "knowledge", "url"))]


def _schema_fields(tool: Any) -> dict[str, Any]:
    schema = getattr(tool, "args_schema", None)
    fields = getattr(schema, "model_fields", None) or getattr(schema, "__fields__", None)
    if fields:
        return dict(fields)
    args = getattr(tool, "args", None)
    return dict(args) if isinstance(args, dict) else {}


def _upload_tool() -> Any | None:
    def find(tools: list[Any]) -> Any | None:
        candidates = _knowledge_tools(tools)
        candidates.sort(key=lambda tool: (getattr(tool, "name", "") != KNOWLEDGE_UPLOAD_TOOL, getattr(tool, "name", "")))
        for tool in candidates:
            try:
                _upload_args(tool, "https://deerflow.example/api/threads/thread/artifacts/mnt/user-data/outputs/material")
            except ValueError:
                continue
            return tool
        return None

    tools = get_cached_mcp_tools()
    tool = find(tools)
    if tool is not None:
        return tool
    # A failed first MCP discovery is cached as an empty list. Retry once so a
    # transient connection failure does not permanently disable this action.
    reset_mcp_tools_cache()
    return find(get_cached_mcp_tools())


def _upload_args(tool: Any, url: str) -> dict[str, Any]:
    fields = _schema_fields(tool)
    values: dict[str, Any] = {}
    knowledge_field = url_field = False
    for name in fields:
        key = name.lower()
        if "knowledge" in key or key in {"kb_id", "kbid", "dataset_id", "dataset", "space_id", "space", "collection_id"}:
            values[name] = KNOWLEDGE_BASE_ID
            knowledge_field = True
        elif key in {"enable_multimodel", "enable_multimodal"}:
            values[name] = True
        elif "url" in key:
            values[name] = url
            url_field = True
    if not knowledge_field or not url_field:
        field_names = ", ".join(fields) or "无"
        raise ValueError(f"知识库工具参数不匹配，当前参数: {field_names}")
    return values


def _validate_preview_url(thread_id: str, path: str, url: str, request_host: str) -> str:
    try:
        parsed = urlsplit(url)
        username = parsed.username
    except ValueError as exc:
        raise ValueError("预览 URL 与当前资料不匹配") from exc
    expected_path = f"/api/public/artifacts/{thread_id}/{path.lstrip('/')}"
    query = parse_qs(parsed.query)
    tokens = query.get("artifact_token", [])
    payload = verify_artifact_token(tokens[0]) if len(tokens) == 1 else None
    normalized_host = request_host.lower().strip()
    if normalized_host.endswith(":443") and parsed.scheme == "https":
        normalized_host = normalized_host[:-4]
    elif normalized_host.endswith(":80") and parsed.scheme == "http":
        normalized_host = normalized_host[:-3]
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.netloc.lower() != normalized_host
        or unquote(parsed.path) != expected_path
        or parsed.fragment
        or username is not None
        or set(query) != {"artifact_token"}
        or payload is None
        or payload["thread_id"] != thread_id
        or payload["path"] != path
    ):
        raise ValueError("预览 URL 与当前资料不匹配")
    return url


def _preview_url(request: Request, thread_id: str, path: str, user_id: str | None) -> str:
    token = create_artifact_token(thread_id=thread_id, path=path, user_id=user_id or "default")
    encoded_path = quote(path.lstrip("/"), safe="/")
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
    base = urlsplit(str(request.base_url))
    host = forwarded_host or request.headers.get("host", "") or base.netloc
    if forwarded_proto in {"http", "https"}:
        scheme = forwarded_proto
    elif host.lower().endswith(":443"):
        scheme = "https"
    else:
        scheme = base.scheme
    if scheme == "https" and host.endswith(":443"):
        host = host[:-4]
    elif scheme == "http" and host.endswith(":80"):
        host = host[:-3]
    external_base = urlunsplit((scheme, host, "", "", "")).rstrip("/")
    return f"{external_base}/api/public/artifacts/{quote(thread_id, safe='')}/{encoded_path}?artifact_token={quote(token, safe='')}"


@router.get("/capabilities")
@require_permission("threads", "read")
async def material_capabilities(request: Request):
    user = getattr(request.state, "user", None)
    is_admin = getattr(user, "system_role", None) == "admin"
    config = get_extensions_config()
    configured_servers = [name for name in KNOWLEDGE_SERVERS if (server := config.mcp_servers.get(name)) and server.enabled]
    return {
        "admin": is_admin,
        "configured": bool(configured_servers),
        "enabled": bool(configured_servers),
        "can_upload": bool(is_admin and configured_servers),
        "available": False,
        "servers": configured_servers,
        "tool": KNOWLEDGE_UPLOAD_TOOL,
        "knowledge_base_id": KNOWLEDGE_BASE_ID,
    }


@router.post("/{thread_id}/upload-knowledge")
@require_permission("threads", "read", owner_check=True, require_existing=True)
async def upload_knowledge(thread_id: ThreadId, request: Request, path: str = Query(...), url: str = Query(...)) -> KnowledgeUploadResponse:
    user = getattr(request.state, "user", None)
    if getattr(user, "system_role", None) != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可以上传知识库")
    if not path.startswith("/mnt/user-data/outputs/"):
        raise HTTPException(status_code=400, detail="Invalid material path")
    materials = await _collect(request, q="", type_key="all", favorites_only=False)
    material = next(
        (item for item in materials if item["thread_id"] == str(thread_id) and item["path"] == path),
        None,
    )
    if material is None or material["status"] != "ready":
        raise HTTPException(status_code=404, detail="Material not found")
    try:
        request_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip() or request.headers.get("host", "")
        preview_url = _validate_preview_url(str(thread_id), path, url, request_host)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    config = get_extensions_config()
    if not any((config.mcp_servers.get(name) and config.mcp_servers[name].enabled) for name in KNOWLEDGE_SERVERS):
        raise HTTPException(status_code=409, detail="知识库 MCP 未配置或未启用")
    tool = await asyncio.to_thread(_upload_tool)
    if tool is None:
        cached_tools = get_cached_mcp_tools()
        discovered = [
            {
                "name": getattr(candidate, "name", ""),
                "parameters": list(_schema_fields(candidate)),
            }
            for candidate in _related_knowledge_tools(cached_tools)
        ]
        if discovered:
            detail = f"工具 {KNOWLEDGE_UPLOAD_TOOL} 参数不兼容；已发现工具: {discovered}"
        else:
            detail = f"未发现 MCP 工具 {KNOWLEDGE_UPLOAD_TOOL}，请检查知识库 MCP 的工具发现状态"
        raise HTTPException(status_code=503, detail=detail)
    try:
        upload_args = _upload_args(tool, preview_url)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    try:
        result = await tool.ainvoke(upload_args)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"知识库上传失败: {exc}") from exc
    remote_id = result.get("id") if isinstance(result, dict) else None
    return KnowledgeUploadResponse(status="uploaded", remote_id=str(remote_id) if remote_id else None)
