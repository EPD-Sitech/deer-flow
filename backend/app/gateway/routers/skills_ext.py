"""Extended skill management endpoints (skills gallery migration).

New endpoints ported from the ai-agent-harness skills platform, added as an
incremental router so the original ``skills.py`` router stays untouched apart
from a small response-model extension. All write operations are admin-only,
matching deer-flow's existing skill management surface.

Note: ``GET /api/skills/categories`` deliberately lives in ``skills.py``
(before its ``GET /api/skills/{skill_name}`` route) so the literal
``categories`` segment is not swallowed by the path parameter.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import zipfile
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.gateway.deps import get_config, require_admin_user
from app.gateway.skills_metadata import (
    delete_skill_metadata_entry,
    generate_skill_metadata_with_retry,
    get_skill_metadata_entry,
    normalize_skill_category,
    normalize_skill_tags,
    request_is_admin,
    save_skill_metadata_entry,
    skill_to_response_dict,
)
from deerflow.agents.lead_agent.prompt import refresh_user_skills_system_prompt_cache_async
from deerflow.config.app_config import AppConfig
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.skills.installer import SkillAlreadyExistsError
from deerflow.skills.storage import SkillStorage, get_or_new_user_skill_storage
from deerflow.skills.types import SKILL_MD_FILE, SkillCategory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["skills-ext"])

_ADMIN_REQUIRED_DETAIL = "Admin privileges required to manage skills."

MAX_SKILL_PACKAGE_SIZE = 2 * 1024 * 1024
SUPPORTED_IMPORT_SUFFIXES = (".skill", ".zip")
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-_]{0,79}$")

# Archive entries we never include when exporting a skill.
_IGNORED_ARCHIVE_PARTS = frozenset({".history", ".git", "__pycache__", ".DS_Store"})


# ── Shared helpers ───────────────────────────────────────────────────────────


def _get_storage(config: AppConfig) -> SkillStorage:
    return get_or_new_user_skill_storage(get_effective_user_id(), app_config=config)


def _load_skills(config: AppConfig) -> list[Any]:
    return _get_storage(config).load_skills(enabled_only=False)


def _find_skill(config: AppConfig, skill_name: str) -> Any | None:
    return next((s for s in _load_skills(config) if s.name == skill_name), None)


def _ensure_skill_exists(config: AppConfig, skill_name: str) -> Any:
    skill = _find_skill(config, skill_name)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    return skill


def _ensure_manageable(skill: Any, request: Request) -> None:
    """Only user-scoped CUSTOM skills may be mutated/deleted.

    Admins may also manage public/legacy skills (harness behaviour: the
    ``_ensure_can_manage_skill`` guard lets admins through).
    """
    if skill.category == SkillCategory.CUSTOM:
        return
    user = getattr(getattr(request, "state", None), "user", None)
    if getattr(user, "system_role", None) == "admin":
        return
    raise HTTPException(status_code=403, detail="Only custom skills can be managed")


def _safe_skill_name(skill_name: str) -> str:
    cleaned = skill_name.replace("\r\n", "").replace("\n", "")
    if not cleaned or "/" in cleaned or "\\" in cleaned or ".." in cleaned:
        raise HTTPException(status_code=400, detail="Invalid skill name")
    return cleaned


async def _refresh_prompt_cache() -> None:
    try:
        await refresh_user_skills_system_prompt_cache_async(get_effective_user_id())
    except Exception:
        logger.warning("Failed to refresh skill prompt cache", exc_info=True)


def _metadata_payload(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    """Shape a metadata entry for API responses (None fields dropped)."""
    if not entry:
        return None
    return {
        "display_name": entry.get("display_name") or None,
        "description_zh": entry.get("description_zh") or None,
        "safety_level": entry.get("safety_level") or None,
        "capabilities": entry.get("capabilities") or None,
        "recommended_scenarios": entry.get("recommended_scenarios") or None,
    }


def _should_ignore_archive_entry(part: str) -> bool:
    return part in _IGNORED_ARCHIVE_PARTS


# ── Request / response models ────────────────────────────────────────────────


class SkillCategoryUpdateRequest(BaseModel):
    display_name: str | None = None
    category: str = "other"
    tags: list[str] = Field(default_factory=list)


class SkillDeleteResponse(BaseModel):
    success: bool
    skill_name: str
    message: str


class SkillBatchDeleteRequest(BaseModel):
    skill_names: list[str] = Field(..., min_length=1, max_length=100)


class SkillBatchDeleteItem(BaseModel):
    skill_name: str
    detail: str


class SkillBatchDeleteResponse(BaseModel):
    success: bool
    deleted: list[str]
    failed: list[SkillBatchDeleteItem]
    message: str


class SkillMetadataResponse(BaseModel):
    display_name: str | None = None
    description_zh: str | None = None
    safety_level: str | None = None
    capabilities: str | None = None
    recommended_scenarios: str | None = None


# ── Skill file editor models (files / versions) ──────────────────────────────


class SkillFileInfo(BaseModel):
    path: str
    size: int
    modified: str


class SkillFilesResponse(BaseModel):
    skill_name: str
    scope: str | None = None
    can_edit: bool = False
    files: list[SkillFileInfo] = Field(default_factory=list)


class SkillFileContentResponse(BaseModel):
    path: str
    content: str
    language: str
    size: int


class SkillFileSaveRequest(BaseModel):
    content: str


class SkillFileSaveResponse(BaseModel):
    path: str
    size: int
    version_id: str


class SkillFileRenameRequest(BaseModel):
    new_path: str


class SkillFileRenameResponse(BaseModel):
    path: str
    size: int
    version_id: str


class SkillVersionInfo(BaseModel):
    version_id: str
    timestamp: str
    files_changed: list[str] = Field(default_factory=list)


class SkillVersionsResponse(BaseModel):
    versions: list[SkillVersionInfo] = Field(default_factory=list)


class SkillRestoreResponse(BaseModel):
    restored_version: str
    backup_version: str
    files_restored: list[str] = Field(default_factory=list)


# ── Skill debug run models ───────────────────────────────────────────────────


class SkillDebugRunRequest(BaseModel):
    prompt: str = Field(..., description="User prompt to run the skill with")
    parameters: dict[str, Any] = Field(default_factory=dict)
    model_name: str | None = None
    timeout: int = Field(default=120, ge=5, le=600)


class SkillDebugMessage(BaseModel):
    role: str
    content: str = ""
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    name: str | None = None
    status: str | None = None


class SkillDebugRunResponse(BaseModel):
    success: bool
    messages: list[SkillDebugMessage] = Field(default_factory=list)
    duration_ms: float = 0.0
    error: str | None = None


# ── Skill evolution models ───────────────────────────────────────────────────


class SkillEvolutionRecordModel(BaseModel):
    id: str
    feedback: str
    summary: str
    status: str
    created_at: str
    applied_at: str | None = None


class SkillEvolutionRecordResponse(BaseModel):
    id: str
    feedback: str
    summary: str
    status: str
    created_at: str
    applied_at: str | None = None


class SkillEvolutionRequest(BaseModel):
    feedback: str = Field(..., min_length=1, max_length=2000)
    thread_id: str | None = None
    model_name: str | None = None


class SkillEvolutionHistoryResponse(BaseModel):
    records: list[SkillEvolutionRecordModel] = Field(default_factory=list)


class SkillEvolutionSuggestionsResponse(BaseModel):
    suggestions: list[str] = Field(default_factory=list)


class SkillMetadataGenerateResponse(BaseModel):
    success: bool
    skill_name: str
    skipped: bool = False
    attempts: int = 0
    metadata: SkillMetadataResponse | None = None
    message: str


class SkillInstallResponse(BaseModel):
    success: bool
    skill_name: str
    message: str


class SkillBatchExportRequest(BaseModel):
    skill_names: list[str] = Field(..., min_length=1, max_length=50)


class CreateSkillRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    display_name: str | None = None
    description: str | None = None
    category: str | None = None
    tags: list[str] = Field(default_factory=list)


class CreateSkillResponse(BaseModel):
    name: str
    scope: str
    skill_dir: str


# ── Category management ──────────────────────────────────────────────────────


@router.patch(
    "/skills/{skill_name}/category",
    response_model=dict,
    summary="Update Skill Category",
    description="Update business category, display name and tags for a custom skill.",
)
async def update_skill_category(
    skill_name: str,
    body: SkillCategoryUpdateRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> dict:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    skill_name = _safe_skill_name(skill_name)
    skill = _ensure_skill_exists(config, skill_name)
    _ensure_manageable(skill, request)

    display_name = body.display_name.strip() if body.display_name is not None else None
    if display_name is not None and not display_name:
        raise HTTPException(status_code=422, detail="Skill 名称不能为空")

    entry = get_skill_metadata_entry(skill.name) or {}
    entry["display_name"] = display_name if display_name is not None else entry.get("display_name")
    entry["category"] = normalize_skill_category(body.category)
    entry["tags"] = normalize_skill_tags(body.tags)
    save_skill_metadata_entry(skill.name, entry)

    return skill_to_response_dict(skill, is_admin=request_is_admin(request))


# ── Delete ───────────────────────────────────────────────────────────────────


async def _delete_public_skill_dir(skill: Any) -> None:
    """Remove a public/legacy skill's directory on disk (admin operation)."""
    skill_dir = getattr(skill, "skill_dir", None)
    if skill_dir is None or not skill_dir.exists():
        raise FileNotFoundError(f"Skill directory for '{skill.name}' not found")
    await asyncio.to_thread(shutil.rmtree, skill_dir)


@router.delete("/skills/{skill_name}", response_model=SkillDeleteResponse, summary="Delete Skill")
async def delete_skill(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillDeleteResponse:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    skill_name = _safe_skill_name(skill_name)
    skill = _ensure_skill_exists(config, skill_name)
    _ensure_manageable(skill, request)

    storage = _get_storage(config)
    try:
        if skill.category == SkillCategory.CUSTOM:
            await asyncio.to_thread(
                storage.delete_custom_skill,
                skill.name,
                history_meta={
                    "action": "human_delete",
                    "author": "human",
                    "thread_id": None,
                    "file_path": SKILL_MD_FILE,
                    "prev_content": None,
                    "new_content": None,
                    "scanner": {"decision": "allow", "reason": "Deletion requested."},
                },
            )
        else:
            # Admin deleting a public/legacy skill — remove its directory.
            await _delete_public_skill_dir(skill)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    delete_skill_metadata_entry(skill.name)
    await _refresh_prompt_cache()
    return SkillDeleteResponse(success=True, skill_name=skill.name, message=f"Skill '{skill.name}' deleted")


@router.post("/skills/batch-delete", response_model=SkillBatchDeleteResponse, summary="Batch Delete Skills")
async def batch_delete_skills(
    body: SkillBatchDeleteRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillBatchDeleteResponse:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    storage = _get_storage(config)
    deleted: list[str] = []
    failed: list[SkillBatchDeleteItem] = []

    for name in body.skill_names:
        safe_name = _safe_skill_name(name)
        skill = _find_skill(config, safe_name)
        if skill is None:
            failed.append(SkillBatchDeleteItem(skill_name=safe_name, detail="Skill not found"))
            continue
        if skill.category != SkillCategory.CUSTOM and not request_is_admin(request):
            failed.append(SkillBatchDeleteItem(skill_name=safe_name, detail="Only custom skills can be deleted"))
            continue
        try:
            if skill.category == SkillCategory.CUSTOM:
                await asyncio.to_thread(storage.delete_custom_skill, safe_name)
            else:
                # Admin batch-deleting public/legacy skills — remove their directories.
                await _delete_public_skill_dir(skill)
            delete_skill_metadata_entry(safe_name)
            deleted.append(safe_name)
        except Exception as e:
            logger.warning("Failed to delete skill %s: %s", safe_name, e)
            failed.append(SkillBatchDeleteItem(skill_name=safe_name, detail=str(e)))

    await _refresh_prompt_cache()
    return SkillBatchDeleteResponse(
        success=len(failed) == 0,
        deleted=deleted,
        failed=failed,
        message=f"Deleted {len(deleted)} skill(s), failed {len(failed)}",
    )


# ── Metadata generation ──────────────────────────────────────────────────────


@router.post(
    "/skills/{skill_name}/metadata/generate",
    response_model=SkillMetadataGenerateResponse,
    summary="Generate Chinese Metadata for a Skill",
)
async def generate_skill_metadata(
    skill_name: str,
    request: Request,
    persist: bool = True,
    config: AppConfig = Depends(get_config),
) -> SkillMetadataGenerateResponse:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    skill_name = _safe_skill_name(skill_name)
    skill = _ensure_skill_exists(config, skill_name)

    def _read_content() -> str:
        try:
            return skill.skill_file.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to read skill content: {e}")

    skill_content = await asyncio.to_thread(_read_content)

    try:
        result = await generate_skill_metadata_with_retry(
            skill.name,
            skill_content,
            skip_existing=False,
            retries=1,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    if persist and result["metadata"] and not result["skipped"]:
        entry = get_skill_metadata_entry(skill.name) or {}
        entry.update(result["metadata"])
        save_skill_metadata_entry(skill.name, entry)

    return SkillMetadataGenerateResponse(
        success=result["success"],
        skill_name=result["skill_name"],
        skipped=result["skipped"],
        attempts=result["attempts"],
        metadata=SkillMetadataResponse(**result["metadata"]) if result["metadata"] else None,
        message=result["message"],
    )


# ── Import / export / create ─────────────────────────────────────────────────


@router.post("/skills/import", response_model=SkillInstallResponse, summary="Import Skill Package")
async def import_skill_package(
    request: Request,
    file: UploadFile = File(..., description="Local .zip or .skill archive to import"),
    config: AppConfig = Depends(get_config),
) -> SkillInstallResponse:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)

    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_IMPORT_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Only .zip and .skill skill packages are supported",
        )

    archive_bytes = await file.read()
    if not archive_bytes:
        raise HTTPException(status_code=400, detail="Uploaded archive is empty")
    if len(archive_bytes) > MAX_SKILL_PACKAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Skill package exceeds the {MAX_SKILL_PACKAGE_SIZE // 1024 // 1024}MB size limit",
        )

    storage = _get_storage(config)
    tmp_path: str | None = None
    try:
        # deer-flow's installer requires a .skill (ZIP) extension.
        with tempfile.NamedTemporaryFile(suffix=".skill", delete=False) as tmp:
            tmp.write(archive_bytes)
            tmp_path = tmp.name

        result = await storage.ainstall_skill_from_archive(tmp_path)
    except SkillAlreadyExistsError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("Failed to import skill package: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to import skill package: {str(e)}") from e
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass

    await _refresh_prompt_cache()

    # Non-blocking auto-generation of Chinese metadata after import.
    skill_name = result.get("skill_name", "")
    if skill_name:
        skill = _find_skill(config, skill_name)
        if skill is not None:

            async def _auto_metadata() -> None:
                try:

                    def _read() -> str:
                        return skill.skill_file.read_text(encoding="utf-8")

                    content = await asyncio.to_thread(_read)
                    gen = await generate_skill_metadata_with_retry(
                        skill.name,
                        content,
                        skip_existing=True,
                        retries=0,
                    )
                    if gen["metadata"] and not gen["skipped"]:
                        entry = get_skill_metadata_entry(skill.name) or {}
                        entry.update(gen["metadata"])
                        save_skill_metadata_entry(skill.name, entry)
                except Exception:
                    logger.warning("Auto metadata generation failed for %s", skill_name, exc_info=True)

            asyncio.create_task(_auto_metadata())

    return SkillInstallResponse(success=True, skill_name=skill_name, message=result.get("message", "Imported"))


def _build_skill_zip(skill: Any, *, root_name: str | None = None) -> BytesIO:
    """Build a ZIP archive of a skill directory."""
    buf = BytesIO()
    skill_dir: Path = skill.skill_dir
    prefix = root_name or skill.name
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "format_version": "1.0",
                    "exported_at": datetime.now(UTC).isoformat(),
                    "skill": {"name": skill.name, "category": str(skill.category)},
                },
                indent=2,
                ensure_ascii=False,
            ),
        )
        for file_path in sorted(skill_dir.rglob("*")):
            if not file_path.is_file() or file_path.is_symlink():
                continue
            relative = file_path.relative_to(skill_dir)
            if any(_should_ignore_archive_entry(part) for part in relative.parts):
                continue
            zf.write(file_path, f"{prefix}/{relative.as_posix()}")
    buf.seek(0)
    return buf


@router.get("/skills/{skill_name}/export", summary="Export Installed Skill")
async def export_installed_skill(
    skill_name: str,
    request: Request,
    format: Literal["zip", "md"] = "zip",
    config: AppConfig = Depends(get_config),
) -> Response:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    skill_name = _safe_skill_name(skill_name)
    skill = _ensure_skill_exists(config, skill_name)

    encoded_name = quote(skill_name)

    if format == "md":
        try:
            content = skill.skill_file.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to read skill content: {e}")
        return Response(
            content=content.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}.skill.md",
                "Access-Control-Expose-Headers": "Content-Disposition",
            },
        )

    buf = _build_skill_zip(skill)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}.skill.zip",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.post("/skills/batch/export", summary="Batch Export Skills")
async def batch_export_skills(
    body: SkillBatchExportRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> Response:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in body.skill_names:
            safe_name = _safe_skill_name(name)
            skill = _find_skill(config, safe_name)
            if skill is None:
                continue
            skill_dir: Path = skill.skill_dir
            for file_path in sorted(skill_dir.rglob("*")):
                if not file_path.is_file() or file_path.is_symlink():
                    continue
                relative = file_path.relative_to(skill_dir)
                if any(_should_ignore_archive_entry(part) for part in relative.parts):
                    continue
                zf.write(file_path, f"{safe_name}/{relative.as_posix()}")
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''skills-export.zip",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.post("/skills/create", response_model=CreateSkillResponse, summary="Create Empty Skill")
async def create_empty_skill(
    body: CreateSkillRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> CreateSkillResponse:
    """Create an empty user-scope skill skeleton (with SKILL.md frontmatter)."""
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)

    raw_name = body.name.strip()
    if not SKILL_NAME_RE.match(raw_name):
        raise HTTPException(
            status_code=400,
            detail="技能名称仅允许小写字母、数字、`-`、`_`，且必须以字母或数字开头。",
        )
    skill_name = _safe_skill_name(raw_name)

    storage = _get_storage(config)
    if storage.custom_skill_exists(skill_name):
        raise HTTPException(status_code=409, detail=f"技能 {skill_name} 已存在")

    display_name = (body.display_name or skill_name).strip()
    description = (body.description or f"{display_name} 技能").strip()
    category = normalize_skill_category(body.category)
    tags = normalize_skill_tags(body.tags)

    frontmatter_lines = [
        "---",
        f"name: {skill_name}",
        f"description: {json.dumps(description, ensure_ascii=False)}",
        f"category: {category}",
    ]
    if tags:
        tag_yaml = ", ".join(json.dumps(t, ensure_ascii=False) for t in tags)
        frontmatter_lines.append(f"tags: [{tag_yaml}]")
    frontmatter_lines.append("---")

    body_lines = [
        "",
        f"# {display_name}",
        "",
        description or "请在此填写技能描述。",
        "",
        "## 适用场景",
        "",
        "- 待补充",
        "",
        "## 使用步骤",
        "",
        "1. 待补充",
        "",
        "## 示例",
        "",
        "```text",
        "# 在此填写示例",
        "```",
        "",
    ]

    try:
        await asyncio.to_thread(
            storage.write_custom_skill,
            skill_name,
            SKILL_MD_FILE,
            "\n".join(frontmatter_lines + body_lines),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    # Persist business category / tags / display name as metadata.
    entry: dict[str, Any] = {"display_name": display_name, "category": category, "tags": tags}
    save_skill_metadata_entry(skill_name, entry)

    await _refresh_prompt_cache()
    return CreateSkillResponse(name=skill_name, scope="user", skill_dir=str(storage.get_custom_skill_dir(skill_name)))


# ── Skill file editor (files / versions) ─────────────────────────────────────
# Ported from the harness skill detail dialog backend: browse, edit, rename and
# delete skill files with automatic versioned backups (.versions/).


def _skill_can_edit(skill: Any, request: Request) -> bool:
    """Whether the caller may edit this skill's files.

    CUSTOM (user-scoped) skills are always editable. Built-in ``PUBLIC`` and
    managed ``INTEGRATION`` skills ship inside (often read-only) deployment
    images, and ``LEGACY`` global-custom skills are shared read-only files;
    admins may still edit them — the write path transparently promotes the
    skill into a writable custom shadow copy (see ``_writable_skill_dir``),
    which overrides the original by name.
    """
    if skill.category == SkillCategory.CUSTOM:
        return True
    return request_is_admin(request)


def _custom_shadow_dir(skill: Any, config: AppConfig) -> Path:
    """Writable custom-root directory that can shadow ``skill`` by name."""
    storage = _get_storage(config)
    return Path(storage.get_custom_skill_dir(skill.name))


def _effective_skill_dir(skill: Any, config: AppConfig) -> Path:
    """Directory to READ a skill's files from.

    CUSTOM skills use their own directory. Built-in PUBLIC / managed
    INTEGRATION / shared LEGACY skills may live in a read-only location; when
    an editable custom shadow copy (same name, under the writable custom root)
    already exists it is preferred so reads reflect prior edits.
    """
    original = getattr(skill, "skill_dir", None)
    if original is None or not Path(original).is_dir():
        raise HTTPException(status_code=404, detail="技能目录不存在")
    if skill.category == SkillCategory.CUSTOM:
        return Path(original)
    try:
        shadow = _custom_shadow_dir(skill, config)
    except Exception:
        logger.debug("Could not resolve custom shadow dir for %s", skill.name, exc_info=True)
        return Path(original)
    return shadow if shadow.is_dir() else Path(original)


def _writable_skill_dir(skill: Any, config: AppConfig) -> Path:
    """Directory to WRITE a skill's files into.

    CUSTOM skills use their own (writable) directory. Built-in / shared skills
    ship in a read-only location (e.g. a container image layer), so the first
    admin edit promotes the whole skill into a writable custom shadow copy that
    shadows the original by name; subsequent reads and writes use that copy.
    """
    original = getattr(skill, "skill_dir", None)
    if original is None or not Path(original).is_dir():
        raise HTTPException(status_code=404, detail="技能目录不存在")
    if skill.category == SkillCategory.CUSTOM:
        return Path(original)
    shadow = _custom_shadow_dir(skill, config)
    if not shadow.is_dir():
        try:
            shutil.copytree(str(original), str(shadow), dirs_exist_ok=True)
        except OSError as e:
            logger.error(
                "Failed to promote skill %s into writable shadow %s: %s",
                skill.name,
                shadow,
                e,
            )
            raise HTTPException(
                status_code=403,
                detail="技能目录只读且无法创建可写副本，请联系管理员确认自定义技能目录可写。",
            ) from e
    return shadow


@router.get(
    "/skills/{skill_name}/files",
    response_model=SkillFilesResponse,
    summary="List Skill Files",
)
async def list_skill_files(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillFilesResponse:
    from app.gateway.skill_file_service import list_files as svc_list_files

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    try:
        files = svc_list_files(_effective_skill_dir(skill, config))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    scope = "public" if skill.category == SkillCategory.PUBLIC else "legacy" if skill.category == SkillCategory.LEGACY else "user"
    return SkillFilesResponse(
        skill_name=skill.name,
        scope=scope,
        can_edit=_skill_can_edit(skill, request),
        files=[SkillFileInfo(path=f.path, size=f.size, modified=f.modified) for f in files],
    )


@router.get(
    "/skills/{skill_name}/files/{file_path:path}",
    response_model=SkillFileContentResponse,
    summary="Read Skill File",
)
async def read_skill_file(
    skill_name: str,
    file_path: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillFileContentResponse:
    from app.gateway.skill_file_service import read_file as svc_read_file

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    try:
        fc = svc_read_file(_effective_skill_dir(skill, config), file_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return SkillFileContentResponse(path=fc.path, content=fc.content, language=fc.language, size=fc.size)


@router.put(
    "/skills/{skill_name}/files/{file_path:path}",
    response_model=SkillFileSaveResponse,
    summary="Save Skill File",
)
async def save_skill_file(
    skill_name: str,
    file_path: str,
    body: SkillFileSaveRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillFileSaveResponse:
    from app.gateway.skill_file_service import write_file as svc_write_file

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        result = svc_write_file(
            _writable_skill_dir(skill, config),
            file_path,
            body.content,
            skill_name=skill.name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except OSError as e:
        logger.error("Failed to write skill file %s/%s: %s", skill_name, file_path, e)
        raise HTTPException(
            status_code=403,
            detail="技能目录只读或写入失败，无法保存。内置/共享技能为只读，请创建自定义技能来覆盖它。",
        ) from e
    await _refresh_prompt_cache()
    return SkillFileSaveResponse(path=result.path, size=result.size, version_id=result.version_id)


@router.delete(
    "/skills/{skill_name}/files/{file_path:path}",
    response_model=SkillFileSaveResponse,
    summary="Delete Skill File",
)
async def delete_skill_file(
    skill_name: str,
    file_path: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillFileSaveResponse:
    from app.gateway.skill_file_service import delete_file as svc_delete

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        result = svc_delete(_writable_skill_dir(skill, config), file_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except OSError as e:
        logger.error("Failed to delete skill file %s/%s: %s", skill_name, file_path, e)
        raise HTTPException(
            status_code=403,
            detail="技能目录只读或写入失败，无法删除。内置/共享技能为只读，请创建自定义技能来覆盖它。",
        ) from e
    await _refresh_prompt_cache()
    return SkillFileSaveResponse(path=result.path, size=result.size, version_id=result.version_id)


@router.post(
    "/skills/{skill_name}/files/{file_path:path}/rename",
    response_model=SkillFileRenameResponse,
    summary="Rename Skill File",
)
async def rename_skill_file(
    skill_name: str,
    file_path: str,
    body: SkillFileRenameRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillFileRenameResponse:
    from app.gateway.skill_file_service import rename_file as svc_rename

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        result = svc_rename(_writable_skill_dir(skill, config), file_path, body.new_path)
    except (ValueError, FileExistsError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except OSError as e:
        logger.error("Failed to rename skill file %s/%s -> %s: %s", skill_name, file_path, body.new_path, e)
        raise HTTPException(
            status_code=403,
            detail="技能目录只读或写入失败，无法重命名。内置/共享技能为只读，请创建自定义技能来覆盖它。",
        ) from e
    await _refresh_prompt_cache()
    return SkillFileRenameResponse(path=result.path, size=result.size, version_id=result.version_id)


@router.get(
    "/skills/{skill_name}/versions",
    response_model=SkillVersionsResponse,
    summary="List Skill Versions",
)
async def list_skill_versions(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillVersionsResponse:
    from app.gateway.skill_file_service import list_versions as svc_list_versions

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无查看版本权限")
    versions = svc_list_versions(_effective_skill_dir(skill, config))
    return SkillVersionsResponse(
        versions=[
            SkillVersionInfo(
                version_id=v.version_id,
                timestamp=v.timestamp,
                files_changed=v.files_changed,
            )
            for v in versions
        ],
    )


def _debug_extract_content(content: Any) -> str:
    """Extract text from a LangChain message content (str or content blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return str(content) if content else ""


@router.post(
    "/skills/{skill_name}/debug/run",
    response_model=SkillDebugRunResponse,
    summary="Debug Run Skill",
)
async def debug_run_skill(
    skill_name: str,
    body: SkillDebugRunRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillDebugRunResponse:
    """Run a skill through the deer-flow agent runtime for debugging.

    Creates a temporary thread, submits a prompt that forces the skill, then
    waits for the run to finish and returns the message trace.
    """
    import time as _time

    from app.gateway.routers.thread_runs import wait_run as df_wait_run
    from app.gateway.routers.threads import ThreadCreateRequest
    from app.gateway.routers.threads import create_thread as df_create_thread
    from app.gateway.run_models import RunCreateRequest

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无调试权限")
    t0 = _time.monotonic()
    try:
        thread = await df_create_thread(
            ThreadCreateRequest(metadata={"purpose": "skill_debug", "skill": skill.name}),
            request,
        )
        thread_id = thread.thread_id

        param_text = ""
        if body.parameters:
            param_text = "\n\n参数:\n" + "\n".join(f"- {k}: {v}" for k, v in body.parameters.items())
        user_message = f"请使用 {skill.name} 技能完成以下任务:\n{body.prompt}{param_text}\n\n提示: 请先读取技能 {skill.name} 的 SKILL.md, 然后按照其中的指引执行。"

        run_body = RunCreateRequest(
            input={"messages": [{"role": "user", "content": user_message}]},
            metadata={"purpose": "skill_debug", "skill": skill.name},
        )
        if body.model_name:
            run_body.context = {"model_name": body.model_name}

        result = await asyncio.wait_for(
            df_wait_run(thread_id=thread_id, body=run_body, request=request),
            timeout=body.timeout,
        )

        messages: list[SkillDebugMessage] = []
        if isinstance(result, dict) and result.get("status") == "error":
            return SkillDebugRunResponse(
                success=False,
                messages=[],
                duration_ms=(_time.monotonic() - t0) * 1000,
                error=result.get("error") or "运行失败",
            )

        raw_messages = result.get("messages", []) if isinstance(result, dict) else []
        for msg in raw_messages:
            if not isinstance(msg, dict):
                continue
            entry = SkillDebugMessage(
                role=str(msg.get("type", msg.get("role", "unknown"))),
                content=_debug_extract_content(msg.get("content", "")),
            )
            if msg.get("tool_calls"):
                entry.tool_calls = [{"name": tc.get("name", ""), "args": tc.get("args", {})} for tc in msg["tool_calls"] if isinstance(tc, dict)]
            if msg.get("name"):
                entry.name = str(msg["name"])
            if msg.get("status"):
                entry.status = str(msg["status"])
            messages.append(entry)

        return SkillDebugRunResponse(
            success=True,
            messages=messages,
            duration_ms=(_time.monotonic() - t0) * 1000,
        )
    except TimeoutError:
        return SkillDebugRunResponse(
            success=False,
            messages=[],
            duration_ms=(_time.monotonic() - t0) * 1000,
            error=f"执行超时 ({body.timeout}s)",
        )
    except Exception as exc:  # noqa: BLE001 - surface as a debug error
        logger.exception("skill_debug.error skill=%s", skill.name)
        return SkillDebugRunResponse(
            success=False,
            messages=[],
            duration_ms=(_time.monotonic() - t0) * 1000,
            error=str(exc),
        )


@router.post(
    "/skills/{skill_name}/versions/{version_id}/restore",
    response_model=SkillRestoreResponse,
    summary="Restore Skill Version",
)
async def restore_skill_version(
    skill_name: str,
    version_id: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillRestoreResponse:
    from app.gateway.skill_file_service import restore_version as svc_restore

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无回滚权限")
    try:
        result = svc_restore(_writable_skill_dir(skill, config), version_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await _refresh_prompt_cache()
    return SkillRestoreResponse(
        restored_version=result.restored_version,
        backup_version=result.backup_version,
        files_restored=result.files_restored,
    )


# ── Skill evolution (AI-driven improvements) ─────────────────────────────────
# Simplified file-backed port of the harness evolution service: records live in
# <skill_dir>/.evolution/records.json and apply goes through the versioned file
# service (restorable via the versions UI).


def _evolution_record_to_model(record: Any) -> SkillEvolutionRecordModel:
    return SkillEvolutionRecordModel(
        id=record.id,
        feedback=record.feedback,
        summary=record.summary,
        status=record.status,
        created_at=record.created_at,
        applied_at=record.applied_at,
    )


@router.post(
    "/skills/{skill_name}/evolve",
    response_model=SkillEvolutionRecordModel,
    summary="Propose AI Evolution",
)
async def propose_skill_evolution(
    skill_name: str,
    body: SkillEvolutionRequest,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillEvolutionRecordResponse:
    from app.gateway.skill_evolution_service import propose_evolution

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        record = await propose_evolution(
            skill.name,
            _writable_skill_dir(skill, config),
            body.feedback,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("propose evolution failed skill=%s", skill.name)
        raise HTTPException(status_code=500, detail=f"演进失败: {e}") from e
    return _evolution_record_to_model(record)


@router.get(
    "/skills/{skill_name}/evolution-history",
    response_model=SkillEvolutionHistoryResponse,
    summary="List Evolution History",
)
async def list_skill_evolution_history(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillEvolutionHistoryResponse:
    from app.gateway.skill_evolution_service import list_records

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    records = list_records(_effective_skill_dir(skill, config))
    return SkillEvolutionHistoryResponse(records=[_evolution_record_to_model(r) for r in records])


@router.get(
    "/skills/{skill_name}/evolution-suggestions",
    response_model=SkillEvolutionSuggestionsResponse,
    summary="List Evolution Feedback Suggestions",
)
async def list_skill_evolution_suggestions(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillEvolutionSuggestionsResponse:
    from app.gateway.skill_evolution_service import SUGGESTION_PROMPTS

    _ensure_skill_exists(config, _safe_skill_name(skill_name))
    return SkillEvolutionSuggestionsResponse(suggestions=SUGGESTION_PROMPTS)


@router.post(
    "/skills/{skill_name}/evolve/{record_id}/apply",
    response_model=SkillEvolutionRecordModel,
    summary="Apply AI Evolution",
)
async def apply_skill_evolution(
    skill_name: str,
    record_id: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillEvolutionRecordResponse:
    from app.gateway.skill_evolution_service import apply_evolution

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        record = apply_evolution(_writable_skill_dir(skill, config), record_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await _refresh_prompt_cache()
    return _evolution_record_to_model(record)


@router.post(
    "/skills/{skill_name}/evolve/{record_id}/reject",
    response_model=SkillEvolutionRecordModel,
    summary="Reject AI Evolution",
)
async def reject_skill_evolution(
    skill_name: str,
    record_id: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillEvolutionRecordResponse:
    from app.gateway.skill_evolution_service import reject_evolution

    skill = _ensure_skill_exists(config, _safe_skill_name(skill_name))
    if not _skill_can_edit(skill, request):
        raise HTTPException(status_code=403, detail="无编辑权限")
    try:
        record = reject_evolution(_writable_skill_dir(skill, config), record_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return _evolution_record_to_model(record)
