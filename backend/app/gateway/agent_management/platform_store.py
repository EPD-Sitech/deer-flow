from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

import yaml

from deerflow.config.agents_config import SOUL_FILENAME, AgentConfig
from deerflow.config.paths import Paths
from deerflow.persistence.agents import AgentExistsError, parse_agent_config

from .names import normalize_migrated_agent_name, runtime_agent_name


class PlatformAgentStore:
    """Small AgentStore-compatible adapter for the shared public directory."""

    def __init__(self, paths: Paths) -> None:
        self.paths = paths

    def _dir(self, name: str) -> Path:
        return self.paths.agent_dir(normalize_migrated_agent_name(name))

    def ensure_runtime_alias(self, name: str) -> str:
        normalized = normalize_migrated_agent_name(name)
        runtime_name = runtime_agent_name(normalized)
        if runtime_name == normalized:
            return runtime_name
        source = self._dir(normalized)
        if not (source / "config.yaml").is_file():
            raise FileNotFoundError(normalized)
        alias = self.paths.agent_dir(runtime_name)
        if alias.is_symlink():
            if alias.resolve(strict=False) != source.resolve(strict=True):
                raise ValueError(f"Runtime alias '{runtime_name}' is already in use")
            return runtime_name
        if alias.exists():
            raise ValueError(f"Runtime alias '{runtime_name}' is already in use")
        alias.symlink_to(source.name, target_is_directory=True)
        return runtime_name

    def get(self, name: str, *, user_id: str | None = None) -> AgentConfig:
        del user_id
        agent_dir = self._dir(name)
        config_file = agent_dir / "config.yaml"
        if not config_file.is_file():
            raise FileNotFoundError(name)
        loaded = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ValueError("config.yaml must contain an object")
        return parse_agent_config(loaded, agent_dir.name)

    def get_soul(self, name: str, *, user_id: str | None = None) -> str | None:
        del user_id
        soul_file = self._dir(name) / SOUL_FILENAME
        if not soul_file.is_file():
            return None
        return soul_file.read_text(encoding="utf-8").strip() or None

    def exists(self, name: str, *, user_id: str | None = None) -> bool:
        del user_id
        return (self._dir(name) / "config.yaml").is_file()

    def list(self, *, user_id: str | None = None) -> list[AgentConfig]:
        del user_id
        if not self.paths.agents_dir.exists():
            return []
        result = []
        for entry in sorted(self.paths.agents_dir.iterdir()):
            if not entry.is_dir() or entry.is_symlink():
                continue
            try:
                result.append(self.get(entry.name))
            except (FileNotFoundError, ValueError):
                continue
        return result

    def create(self, name: str, config: dict, soul: str, *, user_id: str | None = None) -> None:
        del user_id
        agent_dir = self._dir(name)
        if agent_dir.exists():
            raise AgentExistsError(f"Public Agent '{name}' already exists")
        agent_dir.mkdir(parents=True)
        try:
            self._write(agent_dir, config, soul)
        except Exception:
            shutil.rmtree(agent_dir, ignore_errors=True)
            raise

    def update(
        self,
        name: str,
        config: dict | None,
        soul: str | None,
        *,
        user_id: str | None = None,
    ) -> None:
        del user_id
        agent_dir = self._dir(name)
        if not (agent_dir / "config.yaml").is_file():
            raise FileNotFoundError(name)
        self._write(agent_dir, config, soul)

    def delete(self, name: str, *, user_id: str | None = None) -> str:
        del user_id
        agent_dir = self._dir(name)
        if not (agent_dir / "config.yaml").is_file():
            return "missing"
        runtime_name = runtime_agent_name(name)
        alias = self.paths.agent_dir(runtime_name)
        if alias.is_symlink() and alias.resolve(strict=False) == agent_dir.resolve(strict=True):
            alias.unlink()
        shutil.rmtree(agent_dir)
        return "deleted"

    @staticmethod
    def _write(agent_dir: Path, config: dict[str, Any] | None, soul: str | None) -> None:
        pending: list[tuple[Path, Path]] = []
        if config is not None:
            target = agent_dir / "config.yaml"
            temporary = agent_dir / f".config.{uuid.uuid4().hex}.tmp"
            temporary.write_text(
                yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
            pending.append((temporary, target))
        if soul is not None:
            target = agent_dir / SOUL_FILENAME
            temporary = agent_dir / f".soul.{uuid.uuid4().hex}.tmp"
            temporary.write_text(soul, encoding="utf-8")
            pending.append((temporary, target))
        try:
            for temporary, target in pending:
                temporary.replace(target)
        finally:
            for temporary, _ in pending:
                temporary.unlink(missing_ok=True)
