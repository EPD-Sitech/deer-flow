from __future__ import annotations

from collections.abc import Hashable
from typing import Any

from deerflow.config.agents_config import AgentConfig
from deerflow.persistence.agents import AgentStore, get_agent_store

from .platform_metadata import (
    create_platform_agent_metadata,
    get_public_platform_agent_owner,
)


class PlatformDbAgentStore:
    """AgentStore adapter for public platform agents stored in SQL.

    Platform management routes receive only ``scope=platform`` plus the
    runnable ``agent-*`` name. The actual SQL agent row is resolved through the
    ``platform_agents.agent_id`` relationship.
    """

    def __init__(self, store: AgentStore | None = None) -> None:
        self.store = store or get_agent_store()

    def _owner(self, name: str) -> str:
        owner = get_public_platform_agent_owner(name)
        if owner is None:
            raise FileNotFoundError(name)
        return owner

    def ensure_runtime_alias(self, name: str) -> str:
        self._owner(name)
        return name

    def get(self, name: str, *, user_id: str | None = None) -> AgentConfig:
        del user_id
        return self.store.get(name, user_id=self._owner(name))

    def get_raw_config(self, name: str, *, user_id: str | None = None) -> dict[str, Any]:
        del user_id
        reader = getattr(self.store, "get_raw_config", None)
        owner = self._owner(name)
        if reader is not None:
            return reader(name, user_id=owner)
        config = self.store.get(name, user_id=owner)
        return config.model_dump(exclude_none=True, exclude_unset=True)

    def exists(self, name: str, *, user_id: str | None = None) -> bool:
        del user_id
        try:
            owner = self._owner(name)
        except FileNotFoundError:
            return False
        return self.store.exists(name, user_id=owner)

    def get_soul(self, name: str, *, user_id: str | None = None) -> str | None:
        del user_id
        return self.store.get_soul(name, user_id=self._owner(name))

    def list(self, *, user_id: str | None = None) -> list[AgentConfig]:
        del user_id
        return []

    def list_all(self) -> list[tuple[str, AgentConfig]]:
        return []

    def create(self, name: str, config: dict, soul: str, *, user_id: str | None = None) -> None:
        owner = user_id or "default"
        self.store.create(name, config, soul, user_id=owner)
        create_platform_agent_metadata(
            owner,
            name,
            str(config.get("display_name") or config.get("name") or name),
        )

    def update(
        self,
        name: str,
        config: dict | None,
        soul: str | None,
        *,
        user_id: str | None = None,
    ) -> None:
        del user_id
        owner = self._owner(name)
        self.store.update(name, config, soul, user_id=owner)

    def delete(self, name: str, *, user_id: str | None = None) -> str:
        del user_id
        owner = self._owner(name)
        return self.store.delete(name, user_id=owner)

    def signature(self) -> Hashable:
        return self.store.signature()
