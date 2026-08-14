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

from .guide_questions import read_raw_config
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

    def _publish_user_agent(
        self,
        owner_id: str,
        name: str,
        config: AgentConfig,
        soul: str,
        previous_entry: dict[str, Any] | None,
    ) -> str:
        if self.platform_store is None:
            raise ValueError("Public Agent storage is unavailable")
        published_name = normalize_agent_name(name)
        owns_publication = bool(previous_entry and previous_entry.get("published_by_share") and previous_entry.get("published_agent_name") == published_name)
        raw_config = read_raw_config(self.store, name, owner_id)
        if self.platform_store.exists(published_name):
            if not owns_publication:
                raise ShareConflict(f"Public Agent name '{published_name}' is already in use")
            self.platform_store.update(published_name, raw_config, soul)
        else:
            self.platform_store.create(published_name, raw_config, soul)
        return self.platform_store.ensure_runtime_alias(published_name)

    def _unpublish_user_agent(self, entry: dict[str, Any] | None) -> None:
        if not entry or not entry.get("published_by_share") or self.platform_store is None:
            return
        published_name = str(entry.get("published_agent_name") or "")
        if published_name:
            self.platform_store.delete(published_name)

    @staticmethod
    def _response(name: str, entry: dict[str, Any] | None) -> dict[str, Any]:
        enabled = bool(entry and entry.get("enabled"))
        public_slug = str(entry.get("public_slug") or "") if entry else ""
        public_name = public_slug or default_public_name(name)
        return {
            "enabled": enabled,
            "public_slug": public_slug or None,
            "public_name": public_name,
            "public_path": f"/public/agent/{public_name}",
            "runtime_name": str(entry.get("runtime_name")) if enabled and entry and entry.get("runtime_name") else None,
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
            previous_entry = next(
                (item for item in shares if item.get("owner_id") == owner_id and item.get("agent_name") == normalized and item.get("scope", "user") == scope),
                None,
            )
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

            runtime_name: str | None = None
            published_by_share = False
            published_agent_name: str | None = None
            if enabled and scope == "user":
                config, soul = self._agent(owner_id, normalized, scope)
                runtime_name = self._publish_user_agent(
                    owner_id,
                    normalized,
                    config,
                    soul,
                    previous_entry,
                )
                published_by_share = True
                published_agent_name = normalized
            elif enabled and scope == "platform":
                if self.platform_store is None:
                    raise AgentNotFound(f"Agent '{normalized}' not found")
                runtime_name = self.platform_store.ensure_runtime_alias(normalized)
            elif scope == "user":
                self._unpublish_user_agent(previous_entry)

            entry = {
                "owner_id": owner_id,
                "agent_name": normalized,
                "scope": scope,
                "enabled": enabled,
                "public_slug": slug,
                "runtime_name": runtime_name,
                "published_by_share": published_by_share,
                "published_agent_name": published_agent_name,
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
                    if entry.get("scope", "user") == "user":
                        self._unpublish_user_agent(entry)
                    # A stale share entry must not shadow a valid entry with the
                    # same public name. Keep scanning the registry so a renamed
                    # or deleted Agent does not produce a false 404.
                    continue
                runtime_name = str(entry.get("runtime_name") or "")
                if entry.get("scope", "user") == "user":
                    published_name = str(entry.get("published_agent_name") or "")
                    if entry.get("published_by_share"):
                        if not published_name or self.platform_store is None:
                            continue
                        try:
                            runtime_name = self._publish_user_agent(
                                str(entry.get("owner_id") or ""),
                                agent_name,
                                config,
                                soul,
                                entry,
                            )
                        except (FileNotFoundError, ShareConflict, ValueError):
                            continue
                    elif self.platform_store is not None:
                        try:
                            runtime_name = self._publish_user_agent(
                                str(entry.get("owner_id") or ""),
                                agent_name,
                                config,
                                soul,
                                None,
                            )
                        except (FileNotFoundError, ShareConflict, ValueError):
                            continue
                        entry["runtime_name"] = runtime_name
                        entry["published_by_share"] = True
                        entry["published_agent_name"] = agent_name
                        self._write(shares)
                    elif not runtime_name:
                        runtime_name = agent_name
                elif self.platform_store is not None:
                    try:
                        runtime_name = self.platform_store.ensure_runtime_alias(agent_name)
                    except (FileNotFoundError, ValueError):
                        continue
                return {
                    "config": config,
                    "soul": soul,
                    "public_name": public_slug or default_public_name(agent_name),
                    "scope": entry.get("scope", "user"),
                    "owner_id": str(entry.get("owner_id") or ""),
                    "runtime_name": runtime_name,
                }
        return None
