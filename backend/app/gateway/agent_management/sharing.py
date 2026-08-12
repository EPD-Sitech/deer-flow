from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from deerflow.config.agents_config import AgentConfig

from .service import AgentNotFound, normalize_agent_name

_PUBLIC_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_registry_lock = threading.RLock()


class ShareConflict(ValueError):
    pass


def normalize_public_name(value: str) -> str:
    normalized = value.strip().lower()
    if not _PUBLIC_NAME_RE.fullmatch(normalized):
        raise ValueError("Public link aliases must use 1-64 letters, numbers, hyphens, or underscores.")
    return normalized


def default_public_name(agent_name: str) -> str:
    try:
        return normalize_public_name(agent_name)
    except ValueError:
        digest = hashlib.sha256(agent_name.encode("utf-8")).hexdigest()[:12]
        return f"agent-{digest}"


class AgentShareRegistry:
    """Explicit public-share metadata kept outside DeerFlow's Agent schema."""

    def __init__(self, *, store: Any, state_file: Path, platform_store: Any | None = None) -> None:
        self.store = store
        self.platform_store = platform_store
        self.state_file = Path(state_file)

    def _agent(
        self,
        owner_id: str,
        name: str,
        scope: Literal["user", "platform"] = "user",
    ) -> tuple[AgentConfig, str]:
        normalized = normalize_agent_name(name)
        store = self.platform_store if scope == "platform" else self.store
        if store is None:
            raise AgentNotFound(f"Agent '{normalized}' not found")
        try:
            config = store.get(normalized, user_id=owner_id)
            soul = store.get_soul(normalized, user_id=owner_id) or ""
        except FileNotFoundError as exc:
            raise AgentNotFound(f"Agent '{normalized}' not found") from exc
        return config, soul

    def _read(self) -> list[dict[str, Any]]:
        if not self.state_file.exists():
            return []
        loaded = json.loads(self.state_file.read_text(encoding="utf-8"))
        shares = loaded.get("shares", []) if isinstance(loaded, dict) else []
        if not isinstance(shares, list):
            raise ValueError("Invalid public Agent share registry")
        return [entry for entry in shares if isinstance(entry, dict)]

    def _write(self, shares: list[dict[str, Any]]) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_file.with_name(f".{self.state_file.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps({"version": 1, "shares": shares}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.state_file)

    @staticmethod
    def _response(name: str, entry: dict[str, Any] | None) -> dict[str, Any]:
        enabled = bool(entry and entry.get("enabled"))
        public_slug = str(entry.get("public_slug") or "") if entry else ""
        public_name = public_slug or default_public_name(name)
        return {
            "enabled": enabled,
            "public_slug": public_slug or None,
            "public_name": public_name,
            "public_path": f"/agent/{public_name}",
        }

    def get(
        self,
        owner_id: str,
        name: str,
        *,
        scope: Literal["user", "platform"] = "user",
    ) -> dict[str, Any]:
        normalized = normalize_agent_name(name)
        self._agent(owner_id, normalized, scope)
        with _registry_lock:
            entry = next(
                (item for item in self._read() if item.get("owner_id") == owner_id and item.get("agent_name") == normalized and item.get("scope", "user") == scope),
                None,
            )
        return self._response(normalized, entry)

    def update(
        self,
        owner_id: str,
        name: str,
        *,
        enabled: bool,
        public_slug: str | None = None,
        scope: Literal["user", "platform"] = "user",
    ) -> dict[str, Any]:
        normalized = normalize_agent_name(name)
        self._agent(owner_id, normalized, scope)
        slug = normalize_public_name(public_slug) if public_slug else None

        with _registry_lock:
            shares = self._read()
            current_key = (scope, owner_id, normalized)
            active_keys = {normalized, slug, default_public_name(normalized)} - {None}
            retained: list[dict[str, Any]] = []
            for entry in shares:
                entry_scope = entry.get("scope", "user")
                entry_key = (entry_scope, entry.get("owner_id"), entry.get("agent_name"))
                if entry_key == current_key:
                    continue
                try:
                    self._agent(
                        str(entry.get("owner_id") or ""),
                        str(entry.get("agent_name") or ""),
                        entry_scope,
                    )
                except (AgentNotFound, ValueError):
                    continue
                if enabled and entry.get("enabled"):
                    other_keys = {
                        str(entry.get("agent_name") or "").lower(),
                        str(entry.get("public_slug") or "").lower(),
                        default_public_name(str(entry.get("agent_name") or "").lower()),
                    } - {""}
                    if active_keys & other_keys:
                        collision = sorted(active_keys & other_keys)[0]
                        raise ShareConflict(f"Public link name '{collision}' is already in use")
                retained.append(entry)

            entry = {
                "owner_id": owner_id,
                "agent_name": normalized,
                "scope": scope,
                "enabled": enabled,
                "public_slug": slug,
                "updated_at": datetime.now(UTC).isoformat(),
            }
            retained.append(entry)
            self._write(retained)
        return self._response(normalized, entry)

    def resolve(self, public_name: str) -> dict[str, Any] | None:
        try:
            normalized = normalize_public_name(public_name)
        except ValueError:
            return None

        with _registry_lock:
            shares = self._read()
            for entry in shares:
                if not entry.get("enabled"):
                    continue
                agent_name = str(entry.get("agent_name") or "").lower()
                public_slug = str(entry.get("public_slug") or "").lower()
                if normalized not in {
                    agent_name,
                    public_slug,
                    default_public_name(agent_name),
                }:
                    continue
                try:
                    config, soul = self._agent(
                        str(entry.get("owner_id") or ""),
                        agent_name,
                        entry.get("scope", "user"),
                    )
                except (AgentNotFound, ValueError):
                    return None
                return {
                    "config": config,
                    "soul": soul,
                    "public_name": public_slug or default_public_name(agent_name),
                }
        return None
