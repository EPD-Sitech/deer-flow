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
    batch_save_skill_metadata,
    delete_skill_metadata_entry,
    generate_skill_metadata_with_retry,
    get_skill_metadata_entry,
    normalize_skill_category,
    normalize_skill_tags,
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


def _ensure_manageable(skill: Any) -> None:
    """Only user-scoped CUSTOM skills may be mutated/deleted."""
    if skill.category != SkillCategory.CUSTOM:
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


class SkillMetadataGenerateResponse(BaseModel):
    success: bool
    skill_name: str
    skipped: bool = False
    attempts: int = 0
    metadata: SkillMetadataResponse | None = None
    message: str


class BatchSaveMetadataRequest(BaseModel):
    metadata: dict[str, dict[str, str]] = Field(default_factory=dict)


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
    _ensure_manageable(skill)

    display_name = body.display_name.strip() if body.display_name is not None else None
    if display_name is not None and not display_name:
        raise HTTPException(status_code=422, detail="Skill 名称不能为空")

    entry = get_skill_metadata_entry(skill.name) or {}
    entry["display_name"] = display_name if display_name is not None else entry.get("display_name")
    entry["category"] = normalize_skill_category(body.category)
    entry["tags"] = normalize_skill_tags(body.tags)
    save_skill_metadata_entry(skill.name, entry)

    return skill_to_response_dict(skill)


# ── Delete ───────────────────────────────────────────────────────────────────


@router.delete("/skills/{skill_name}", response_model=SkillDeleteResponse, summary="Delete Skill")
async def delete_skill(
    skill_name: str,
    request: Request,
    config: AppConfig = Depends(get_config),
) -> SkillDeleteResponse:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    skill_name = _safe_skill_name(skill_name)
    skill = _ensure_skill_exists(config, skill_name)
    _ensure_manageable(skill)

    storage = _get_storage(config)
    try:
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
        if skill.category != SkillCategory.CUSTOM:
            failed.append(SkillBatchDeleteItem(skill_name=safe_name, detail="Only custom skills can be deleted"))
            continue
        try:
            await asyncio.to_thread(storage.delete_custom_skill, safe_name)
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


@router.post("/skills/metadata/batch-save", summary="Batch Save Generated Skill Metadata")
async def batch_save_generated_metadata(
    body: BatchSaveMetadataRequest,
    request: Request,
) -> dict:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)
    if not body.metadata:
        raise HTTPException(status_code=422, detail="metadata is required")

    normalized: dict[str, dict[str, Any]] = {}
    for name, fields in body.metadata.items():
        if not isinstance(fields, dict):
            continue
        entry = get_skill_metadata_entry(name) or {}
        for key in (
            "display_name",
            "description_zh",
            "safety_level",
            "capabilities",
            "recommended_scenarios",
        ):
            value = fields.get(key)
            if isinstance(value, str):
                entry[key] = value.strip()
            elif value is not None:
                entry[key] = str(value)
        normalized[name] = entry

    batch_save_skill_metadata(normalized)
    return {"success": True, "saved": len(normalized)}


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
