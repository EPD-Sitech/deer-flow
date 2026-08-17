"""Skill file browsing, editing, and versioning service (ported from harness).

Security notes:
- All relative paths are validated against directory traversal.
- Only whitelisted file extensions are allowed for writes.
- File size is bounded (512 KB per file).
- Version history is capped (20 versions).
- Per-skill locks prevent concurrent write/restore race conditions.

The harness ``SkillsContentRepo`` sync is intentionally omitted: the
filesystem remains the runtime source of truth in deer-flow.
"""
from __future__ import annotations

import logging
import os
import shutil
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

MAX_FILE_SIZE = 512 * 1024  # 512 KB
MAX_VERSIONS = 20
VERSIONS_DIR = ".versions"

ALLOWED_EXTENSIONS = {".md", ".py", ".txt", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh"}
BLOCKED_NAMES = {"__pycache__", ".git", VERSIONS_DIR, "node_modules", ".venv", ".env"}

# ── Per-skill write lock (prevents concurrent write/restore race conditions) ─
_skill_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)

LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".toml": "toml",
    ".txt": "text",
    ".cfg": "text",
    ".ini": "text",
    ".sh": "shell",
}


# ── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class FileInfo:
    path: str
    size: int
    modified: str  # ISO 8601


@dataclass
class FileContent:
    path: str
    content: str
    language: str
    size: int


@dataclass
class SaveResult:
    path: str
    size: int
    version_id: str


@dataclass
class VersionInfo:
    version_id: str
    timestamp: str  # ISO 8601
    files_changed: list[str]


@dataclass
class RestoreResult:
    restored_version: str
    backup_version: str
    files_restored: list[str]


# ── Path validation ──────────────────────────────────────────────────────────

def _validate_rel_path(skill_dir: Path, rel_path: str) -> Path:
    """Validate and resolve a relative path, preventing directory traversal."""
    clean = rel_path.replace("\\", "/").lstrip("/")
    if not clean:
        raise ValueError("空路径")

    parts = clean.split("/")
    for part in parts:
        if part in (".", ".."):
            raise ValueError("路径不合法")
        if part in BLOCKED_NAMES:
            raise ValueError(f"不允许访问 {part}")

    resolved = (skill_dir / clean).resolve()
    skill_resolved = skill_dir.resolve()

    if not str(resolved).startswith(str(skill_resolved) + os.sep) and resolved != skill_resolved:
        raise ValueError("路径越界")

    return resolved


def _detect_language(file_path: str) -> str:
    """Detect language from file extension."""
    ext = Path(file_path).suffix.lower()
    return LANGUAGE_MAP.get(ext, "text")


def _validate_skill_md_frontmatter(
    content: str,
    *,
    expected_skill_name: str | None = None,
) -> None:
    """Validate SKILL.md YAML frontmatter integrity.

    SKILL.md is the skill entry file and must contain a well-formed YAML
    frontmatter block with at least a ``name`` field.
    """
    content = content.removeprefix("\ufeff")
    if not content.startswith("---"):
        raise ValueError("SKILL.md 必须包含 YAML frontmatter（以 '---' 开头）")
    end = content.find("\n---", 3)
    if end == -1:
        raise ValueError("SKILL.md frontmatter 未正确闭合（缺少结束 '---'）")
    yaml_str = content[3:end].strip()
    try:
        import yaml  # type: ignore[import-untyped]

        parsed = yaml.safe_load(yaml_str)
    except Exception as exc:  # noqa: BLE001 - surface as ValueError
        raise ValueError(f"SKILL.md YAML frontmatter 格式错误: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("SKILL.md frontmatter 必须是 YAML 对象")
    name_val = str(parsed.get("name") or "").strip()
    if not name_val:
        raise ValueError("SKILL.md frontmatter 缺少必填字段: name")
    if expected_skill_name and name_val != expected_skill_name:
        raise ValueError(
            f"SKILL.md frontmatter name '{name_val}' "
            f"与技能目录名 '{expected_skill_name}' 不一致"
        )


# ── File operations ──────────────────────────────────────────────────────────

def list_files(skill_dir: Path) -> list[FileInfo]:
    """List all non-hidden, non-blocked files in the skill directory."""
    if not skill_dir.is_dir():
        raise FileNotFoundError(f"Skill 目录不存在: {skill_dir}")

    result: list[FileInfo] = []
    skill_resolved = skill_dir.resolve()

    for p in sorted(skill_resolved.rglob("*")):
        if not p.is_file():
            continue

        rel = p.relative_to(skill_resolved)
        if any(part in BLOCKED_NAMES for part in rel.parts):
            continue

        if any(part.startswith(".") and part != "." for part in rel.parts):
            continue

        stat = p.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
        result.append(FileInfo(
            path=str(rel),
            size=stat.st_size,
            modified=mtime,
        ))

    return result


def read_file(skill_dir: Path, rel_path: str) -> FileContent:
    """Read a file from the skill directory."""
    resolved = _validate_rel_path(skill_dir, rel_path)

    if not resolved.is_file():
        raise FileNotFoundError(f"文件不存在: {rel_path}")

    size = resolved.stat().st_size
    if size > MAX_FILE_SIZE:
        raise ValueError(f"文件过大 ({size} bytes), 上限 {MAX_FILE_SIZE} bytes")

    content = resolved.read_text(encoding="utf-8", errors="replace")
    language = _detect_language(rel_path)

    return FileContent(
        path=rel_path,
        content=content,
        language=language,
        size=len(content.encode("utf-8")),
    )


def write_file(
    skill_dir: Path,
    rel_path: str,
    content: str,
    *,
    skill_name: str | None = None,
) -> SaveResult:
    """Write content to a file, creating a versioned backup first."""
    ext = Path(rel_path).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"不允许的文件类型: {ext}, 允许: {', '.join(sorted(ALLOWED_EXTENSIONS))}")

    content_bytes = content.encode("utf-8")
    if len(content_bytes) > MAX_FILE_SIZE:
        raise ValueError(f"内容过大 ({len(content_bytes)} bytes), 上限 {MAX_FILE_SIZE} bytes")

    if rel_path.upper() == "SKILL.MD":
        _validate_skill_md_frontmatter(content, expected_skill_name=skill_name)

    resolved = _validate_rel_path(skill_dir, rel_path)

    lock_key = str(skill_dir.resolve())
    with _skill_locks[lock_key]:
        version_id = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        if resolved.is_file():
            _backup_file(skill_dir, rel_path, version_id)

        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")

        _cleanup_old_versions(skill_dir)

    return SaveResult(
        path=rel_path,
        size=len(content_bytes),
        version_id=version_id,
    )


def delete_file(skill_dir: Path, rel_path: str) -> SaveResult:
    """Delete a single file inside ``skill_dir``. SKILL.md cannot be deleted."""
    clean = rel_path.replace("\\", "/").lstrip("/")
    if clean.upper() == "SKILL.MD":
        raise ValueError("SKILL.md 不允许删除")
    resolved = _validate_rel_path(skill_dir, rel_path)
    if not resolved.is_file():
        raise FileNotFoundError(f"文件不存在: {rel_path}")

    lock_key = str(skill_dir.resolve())
    with _skill_locks[lock_key]:
        version_id = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        _backup_file(skill_dir, rel_path, version_id)
        try:
            resolved.unlink()
        except OSError as exc:
            raise OSError(f"删除文件失败: {exc}") from exc
        _cleanup_old_versions(skill_dir)

    return SaveResult(path=rel_path, size=0, version_id=version_id)


def rename_file(skill_dir: Path, src_rel: str, dst_rel: str) -> SaveResult:
    """Rename / move a file inside ``skill_dir``. SKILL.md cannot be renamed."""
    clean_src = src_rel.replace("\\", "/").lstrip("/")
    clean_dst = dst_rel.replace("\\", "/").lstrip("/")
    if clean_src.upper() == "SKILL.MD" or clean_dst.upper() == "SKILL.MD":
        raise ValueError("SKILL.md 不允许重命名")
    if not clean_dst:
        raise ValueError("新路径为空")

    ext = Path(clean_dst).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"不允许的文件类型: {ext}, 允许: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    src_resolved = _validate_rel_path(skill_dir, clean_src)
    if not src_resolved.is_file():
        raise FileNotFoundError(f"源文件不存在: {src_rel}")
    if dst_resolved := _validate_rel_path(skill_dir, clean_dst):
        if dst_resolved.exists():
            raise FileExistsError(f"目标已存在: {dst_rel}")

    lock_key = str(skill_dir.resolve())
    with _skill_locks[lock_key]:
        version_id = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        _backup_file(skill_dir, clean_src, version_id)
        dst_resolved.parent.mkdir(parents=True, exist_ok=True)
        try:
            src_resolved.rename(dst_resolved)
        except OSError as exc:
            raise OSError(f"重命名失败: {exc}") from exc
        _cleanup_old_versions(skill_dir)

    try:
        size = dst_resolved.stat().st_size
    except OSError:
        size = 0
    return SaveResult(path=clean_dst, size=size, version_id=version_id)


# ── Versioning ───────────────────────────────────────────────────────────────

def _backup_file(skill_dir: Path, rel_path: str, version_id: str) -> None:
    """Backup a single file to .versions/{version_id}/."""
    src = _validate_rel_path(skill_dir, rel_path)
    if not src.is_file():
        return

    versions_root = skill_dir / VERSIONS_DIR
    version_dir = versions_root / version_id
    version_dir.mkdir(parents=True, exist_ok=True)

    dest = version_dir / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dest))


def list_versions(skill_dir: Path) -> list[VersionInfo]:
    """List all version backups, newest first."""
    versions_root = skill_dir / VERSIONS_DIR
    if not versions_root.is_dir():
        return []

    result: list[VersionInfo] = []
    for entry in sorted(versions_root.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        version_id = entry.name
        try:
            ts = datetime.strptime(version_id, "%Y%m%d_%H%M%S").replace(tzinfo=UTC)
        except ValueError:
            continue

        files_changed = []
        for f in entry.rglob("*"):
            if f.is_file():
                files_changed.append(str(f.relative_to(entry)))

        result.append(VersionInfo(
            version_id=version_id,
            timestamp=ts.isoformat(),
            files_changed=files_changed,
        ))

    return result


def restore_version(skill_dir: Path, version_id: str) -> RestoreResult:
    """Restore from a version backup, backing up current state first."""
    try:
        datetime.strptime(version_id, "%Y%m%d_%H%M%S")
    except ValueError:
        raise ValueError("版本 ID 格式不合法")

    versions_root = skill_dir / VERSIONS_DIR
    version_dir = versions_root / version_id

    if not version_dir.is_dir():
        raise FileNotFoundError(f"版本不存在: {version_id}")

    lock_key = str(skill_dir.resolve())
    with _skill_locks[lock_key]:
        backup_id = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        current_files = list_files(skill_dir)
        for fi in current_files:
            _backup_file(skill_dir, fi.path, backup_id)

        files_to_restore: list[str] = []
        for f in version_dir.rglob("*"):
            if f.is_file():
                rel = str(f.relative_to(version_dir))
                files_to_restore.append(rel)

        for rel in files_to_restore:
            src = version_dir / rel
            dest = skill_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(dest))

        _cleanup_old_versions(skill_dir)

    return RestoreResult(
        restored_version=version_id,
        backup_version=backup_id,
        files_restored=files_to_restore,
    )


def _cleanup_old_versions(skill_dir: Path) -> None:
    """Keep only the newest MAX_VERSIONS versions."""
    versions_root = skill_dir / VERSIONS_DIR
    if not versions_root.is_dir():
        return

    dirs = sorted(
        [d for d in versions_root.iterdir() if d.is_dir()],
        key=lambda d: d.name,
        reverse=True,
    )
    for old in dirs[MAX_VERSIONS:]:
        shutil.rmtree(old, ignore_errors=True)
