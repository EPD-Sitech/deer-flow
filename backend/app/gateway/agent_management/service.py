from __future__ import annotations

import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import yaml

from deerflow.config.agents_config import AgentConfig
from deerflow.persistence.agents import AgentExistsError

from .names import MIGRATED_AGENT_NAME_PATTERN, normalize_migrated_agent_name

_AGENT_NAME_RE = MIGRATED_AGENT_NAME_PATTERN
_VERSION_ID_RE = re.compile(r"^[0-9]{14}(?:-[0-9]+)?$")
_MAX_IMPORT_BYTES = 10 * 1024 * 1024


class InvalidAgentArchive(ValueError):
    pass


class AgentNotFound(FileNotFoundError):
    pass


@dataclass(frozen=True)
class AgentArchive:
    content: bytes
    media_type: str
    filename: str


@dataclass
class ImportResult:
    imported: list[dict[str, str]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)


@dataclass
class BatchDeleteResult:
    deleted: list[str] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)


def normalize_agent_name(name: str) -> str:
    return normalize_migrated_agent_name(name)


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower().strip()).strip("-")


def _config_document(config: AgentConfig, *, name: str | None = None) -> dict[str, Any]:
    document = config.model_dump(exclude_none=True, exclude_unset=True)
    document["name"] = name or config.name
    return document


def _safe_archive_names(archive: zipfile.ZipFile) -> None:
    for item in archive.infolist():
        path = Path(item.filename)
        if item.filename.startswith(("/", "\\")) or ".." in path.parts:
            raise InvalidAgentArchive(f"unsafe archive path: {item.filename}")


class AgentManagementService:
    """Backend-neutral management operations layered on DeerFlow's AgentStore."""

    def __init__(self, *, store: Any, user_id: str, state_dir: Path) -> None:
        self.store = store
        self.user_id = user_id
        self.state_dir = Path(state_dir)

    def _get(self, name: str) -> tuple[str, AgentConfig, str]:
        normalized = normalize_agent_name(name)
        try:
            config = self.store.get(normalized, user_id=self.user_id)
            soul = self.store.get_soul(normalized, user_id=self.user_id) or ""
        except FileNotFoundError as exc:
            raise AgentNotFound(f"Agent '{normalized}' not found") from exc
        return normalized, config, soul

    def describe(self, name: str) -> dict[str, Any]:
        normalized, config, soul = self._get(name)
        result = _config_document(config, name=normalized)
        result["soul"] = soul
        return result

    def update_files(self, name: str, *, config_yaml: str | None = None, soul: str | None = None) -> dict[str, Any]:
        normalized, current, _ = self._get(name)
        config_document: dict[str, Any] | None = None
        if config_yaml is not None:
            loaded = yaml.safe_load(config_yaml)
            if not isinstance(loaded, dict):
                raise ValueError("config_yaml must contain a YAML object")
            config_name = loaded.get("name")
            if not config_name:
                raise ValueError("config_yaml is missing the required name field")
            if normalize_agent_name(str(config_name)) != normalized:
                raise ValueError(f"config_yaml name '{config_name}' does not match agent '{normalized}'")
            validated = AgentConfig(**loaded)
            config_document = _config_document(validated, name=normalized)
        if soul is not None and not soul.strip():
            raise ValueError("SOUL.md content cannot be empty")
        self.store.update(normalized, config_document, soul, user_id=self.user_id)
        return self.describe(normalized)

    def validate_agent(self, name: str) -> dict[str, Any]:
        normalized, config, soul = self._get(name)
        checks: list[dict[str, str]] = [
            {"check": "config_exists", "status": "pass", "message": "Agent config is available"},
            {"check": "name_valid", "status": "pass", "message": f"Agent name '{normalized}' is valid"},
        ]
        if config.description.strip():
            checks.append({"check": "description_set", "status": "pass", "message": "Description is set"})
        else:
            checks.append({"check": "description_set", "status": "warn", "message": "Consider adding a description"})
        if soul.strip():
            checks.append({"check": "soul_not_empty", "status": "pass", "message": "SOUL.md content is not empty"})
        else:
            checks.append({"check": "soul_not_empty", "status": "error", "message": "SOUL.md content is empty"})
        errors = sum(item["status"] == "error" for item in checks)
        warnings = sum(item["status"] == "warn" for item in checks)
        return {"valid": errors == 0, "checks": checks, "errors": errors, "warnings": warnings}

    def export_agent(self, name: str, *, format: Literal["zip", "md"] = "zip") -> AgentArchive:
        normalized, config, soul = self._get(name)
        document = _config_document(config, name=normalized)
        if format == "md":
            frontmatter = yaml.safe_dump(document, allow_unicode=True, sort_keys=False).rstrip()
            content = f"---\n{frontmatter}\n---\n\n{soul}".encode()
            return AgentArchive(content, "text/markdown; charset=utf-8", f"{normalized}.agent.md")
        if format != "zip":
            raise ValueError("format must be 'zip' or 'md'")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format_version": "1.0",
                        "exported_at": datetime.now(UTC).isoformat(),
                        "source_platform": "deer-flow",
                        "agent": {"name": normalized},
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
            archive.writestr("config.yaml", yaml.safe_dump(document, allow_unicode=True, sort_keys=False))
            archive.writestr("SOUL.md", soul)
        return AgentArchive(output.getvalue(), "application/zip", f"{normalized}.agent.zip")

    def batch_export(self, names: list[str]) -> AgentArchive:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for requested_name in names:
                try:
                    normalized, config, soul = self._get(requested_name)
                except (AgentNotFound, ValueError):
                    continue
                archive.writestr(f"{normalized}/config.yaml", yaml.safe_dump(_config_document(config, name=normalized), allow_unicode=True, sort_keys=False))
                archive.writestr(f"{normalized}/SOUL.md", soul)
        return AgentArchive(output.getvalue(), "application/zip", "agents-export.zip")

    def clone_agent(
        self,
        source_name: str,
        target_name: str,
        *,
        destination_store: Any | None = None,
        destination_user_id: str | None = None,
    ) -> AgentConfig:
        _, source, soul = self._get(source_name)
        target = normalize_agent_name(target_name)
        document = _config_document(source, name=target)
        store = destination_store or self.store
        user_id = destination_user_id or self.user_id
        store.create(target, document, soul, user_id=user_id)
        return store.get(target, user_id=user_id)

    def import_agent(self, content: bytes, *, filename: str, name_override: str = "", overwrite: bool = False) -> ImportResult:
        if len(content) > _MAX_IMPORT_BYTES:
            raise InvalidAgentArchive(f"agent archive exceeds {_MAX_IMPORT_BYTES // 1024 // 1024} MB")
        lower_name = filename.lower()
        if lower_name.endswith(".md"):
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise InvalidAgentArchive("agent markdown must be UTF-8") from exc
            config, soul = self._parse_markdown(text)
            return self._import_documents([(name_override or str(config.get("name", "")), config, soul)], overwrite=overwrite)
        if not lower_name.endswith(".zip"):
            raise InvalidAgentArchive("only .zip, .agent.zip, .md and .agent.md files are supported")
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except zipfile.BadZipFile as exc:
            raise InvalidAgentArchive("invalid ZIP archive") from exc
        with archive:
            _safe_archive_names(archive)
            names = set(archive.namelist())
            documents: list[tuple[str, dict[str, Any], str]] = []
            if "config.yaml" in names:
                config = self._read_archive_config(archive, "config.yaml")
                soul = archive.read("SOUL.md").decode("utf-8") if "SOUL.md" in names else ""
                documents.append((name_override or str(config.get("name", "")), config, soul))
            else:
                roots = sorted({item.split("/", 1)[0] for item in names if "/" in item and not item.startswith("__MACOSX/")})
                for root in roots:
                    config_path = f"{root}/config.yaml"
                    if config_path not in names:
                        continue
                    config = self._read_archive_config(archive, config_path)
                    soul_path = f"{root}/SOUL.md"
                    soul = archive.read(soul_path).decode("utf-8") if soul_path in names else ""
                    documents.append((str(config.get("name") or root), config, soul))
            if not documents:
                raise InvalidAgentArchive("archive does not contain config.yaml")
            return self._import_documents(documents, overwrite=overwrite)

    @staticmethod
    def _read_archive_config(archive: zipfile.ZipFile, path: str) -> dict[str, Any]:
        loaded = yaml.safe_load(archive.read(path).decode("utf-8")) or {}
        if not isinstance(loaded, dict):
            raise InvalidAgentArchive(f"{path} must contain a YAML object")
        return loaded

    @staticmethod
    def _parse_markdown(content: str) -> tuple[dict[str, Any], str]:
        if not content.startswith("---"):
            raise InvalidAgentArchive("agent markdown is missing YAML frontmatter")
        parts = content.split("---", 2)
        loaded = yaml.safe_load(parts[1]) or {}
        if not isinstance(loaded, dict):
            raise InvalidAgentArchive("agent frontmatter must be a YAML object")
        return loaded, parts[2].strip()

    def _import_documents(self, documents: list[tuple[str, dict[str, Any], str]], *, overwrite: bool) -> ImportResult:
        result = ImportResult()
        for raw_name, raw_config, soul in documents:
            normalized = raw_name.lower() if _AGENT_NAME_RE.fullmatch(raw_name) else _slugify(raw_name)
            if not normalized:
                result.errors.append({"name": raw_name or "unknown", "error": "Agent name is missing or invalid"})
                continue
            try:
                normalized = normalize_agent_name(normalized)
                raw_config = dict(raw_config)
                raw_config["name"] = normalized
                config = AgentConfig(**raw_config)
                document = _config_document(config, name=normalized)
                existed = self.store.exists(normalized, user_id=self.user_id)
                if existed and not overwrite:
                    raise AgentExistsError(normalized)
                if existed:
                    self.store.update(normalized, document, soul, user_id=self.user_id)
                    status = "overwritten"
                else:
                    self.store.create(normalized, document, soul, user_id=self.user_id)
                    status = "created"
                result.imported.append({"name": normalized, "status": status, "source": "upload"})
            except AgentExistsError:
                result.errors.append({"name": normalized, "error": f"Agent '{normalized}' already exists"})
            except Exception as exc:
                result.errors.append({"name": normalized, "error": str(exc)})
        return result

    def batch_delete(self, names: list[str]) -> BatchDeleteResult:
        result = BatchDeleteResult()
        for requested_name in names:
            try:
                normalized = normalize_agent_name(requested_name)
                outcome = self.store.delete(normalized, user_id=self.user_id)
                if outcome != "deleted":
                    raise AgentNotFound(f"Agent '{normalized}' not found")
                result.deleted.append(normalized)
            except Exception as exc:
                result.errors.append({"name": requested_name, "error": str(exc)})
        return result

    def _versions_dir(self, name: str) -> Path:
        normalized, _, _ = self._get(name)
        return self.state_dir / "agent-management" / "versions" / normalized

    def create_version(self, name: str, message: str = "") -> dict[str, Any]:
        normalized, config, soul = self._get(name)
        versions_dir = self._versions_dir(normalized)
        versions_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC)
        base_id = timestamp.strftime("%Y%m%d%H%M%S")
        version_id = base_id
        suffix = 1
        while (versions_dir / f"{version_id}.json").exists():
            version_id = f"{base_id}-{suffix}"
            suffix += 1
        snapshot = {
            "version_id": version_id,
            "created_at": timestamp.isoformat(),
            "message": message,
            "config": _config_document(config, name=normalized),
            "soul": soul,
        }
        self._write_json(versions_dir / f"{version_id}.json", snapshot)
        return self._version_summary(snapshot)

    def list_versions(self, name: str) -> list[dict[str, Any]]:
        versions_dir = self._versions_dir(name)
        if not versions_dir.exists():
            return []
        snapshots = [self._read_json(path) for path in sorted(versions_dir.glob("*.json"), reverse=True)]
        return [self._version_summary(snapshot) for snapshot in snapshots]

    def get_version(self, name: str, version_id: str) -> dict[str, Any] | None:
        if not _VERSION_ID_RE.fullmatch(version_id):
            return None
        path = self._versions_dir(name) / f"{version_id}.json"
        return self._read_json(path) if path.exists() else None

    def restore_version(self, name: str, version_id: str) -> dict[str, Any]:
        snapshot = self.get_version(name, version_id)
        if snapshot is None:
            raise AgentNotFound(f"Version '{version_id}' not found")
        self.create_version(name, f"auto-save before restore to {version_id}")
        self.store.update(normalize_agent_name(name), snapshot["config"], snapshot["soul"], user_id=self.user_id)
        return {"restored": True, "version": self._version_summary(snapshot)}

    @staticmethod
    def _version_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
        return {
            "version_id": snapshot["version_id"],
            "created_at": snapshot.get("created_at", ""),
            "message": snapshot.get("message", ""),
            "has_config": bool(snapshot.get("config")),
            "has_soul": bool(snapshot.get("soul")),
        }

    @staticmethod
    def _write_json(path: Path, data: dict[str, Any]) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"Invalid version snapshot: {path.name}")
        return loaded
