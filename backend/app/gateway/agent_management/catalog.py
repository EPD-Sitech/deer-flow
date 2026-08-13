from __future__ import annotations

import asyncio
import logging
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException

from app.gateway.routers.agents import _require_agents_api_enabled
from deerflow.config.paths import Paths, get_paths
from deerflow.persistence.agents import get_agent_store, parse_agent_config
from deerflow.persistence.agents.file import FileAgentStore
from deerflow.runtime.user_context import get_current_user, get_effective_user_id

from .guide_questions import guide_questions_from_document, read_raw_config
from .platform_store import PlatformAgentStore

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent-management", tags=["agent-management"])


class AgentCatalogService:
    def __init__(self, *, store: Any, user_id: str, paths: Paths, can_manage_public: bool) -> None:
        self.store = store
        self.user_id = user_id
        self.paths = paths
        self.can_manage_public = can_manage_public

    def _item(
        self,
        config,
        *,
        scope: str,
        can_manage: bool,
        runtime_name: str | None = None,
        source_store: Any | None = None,
    ) -> dict[str, Any]:
        owns_agent = scope == "user"
        guide_questions: list[dict[str, str]] = []
        try:
            guide_questions = guide_questions_from_document(
                read_raw_config(
                    source_store or self.store,
                    config.name,
                    self.user_id,
                    state_dir=self.paths.user_dir(self.user_id),
                )
            )
        except (FileNotFoundError, ValueError):
            logger.warning("Failed to load guide questions for Agent '%s'", config.name, exc_info=True)
        return {
            **config.model_dump(exclude_none=True, exclude_unset=True),
            "name": config.name,
            "runtime_name": runtime_name or config.name,
            "scope": scope,
            "can_manage": can_manage,
            "can_view_details": True,
            "can_edit_guide_questions": self.can_manage_public,
            "can_edit": can_manage,
            "can_delete": can_manage,
            "can_export": owns_agent or can_manage,
            "can_clone": owns_agent or can_manage,
            "can_share": can_manage,
            "can_batch": can_manage,
            "guide_questions": guide_questions,
        }

    def _public_agents(self) -> list:
        root = self.paths.agents_dir
        if not root.exists():
            return []
        agents = []
        for entry in sorted(root.iterdir()):
            config_file = entry / "config.yaml"
            if not entry.is_dir() or entry.is_symlink() or not config_file.is_file():
                continue
            try:
                loaded = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
                if not isinstance(loaded, dict):
                    raise ValueError("config.yaml must contain an object")
                agents.append(parse_agent_config(loaded, entry.name))
            except Exception:  # noqa: BLE001 - one invalid public Agent must not hide the catalog
                logger.warning("Skipping invalid public Agent '%s'", entry.name, exc_info=True)
        return agents

    def list_agents(self) -> list[dict[str, Any]]:
        custom = self.store.list(user_id=self.user_id)
        if isinstance(self.store, FileAgentStore):
            custom = [config for config in custom if (self.paths.user_agent_dir(self.user_id, config.name) / "config.yaml").is_file()]
        custom_names = {config.name for config in custom}
        public = [config for config in self._public_agents() if config.name not in custom_names]
        platform_store = PlatformAgentStore(self.paths)
        return [
            *(self._item(config, scope="user", can_manage=True) for config in sorted(custom, key=lambda item: item.name)),
            *(
                self._item(
                    config,
                    scope="platform",
                    can_manage=self.can_manage_public,
                    runtime_name=platform_store.ensure_runtime_alias(config.name),
                    source_store=platform_store,
                )
                for config in sorted(public, key=lambda item: item.name)
            ),
        ]


@router.get("/catalog")
async def list_agent_catalog() -> dict[str, list[dict[str, Any]]]:
    _require_agents_api_enabled()
    try:
        service = AgentCatalogService(
            store=get_agent_store(),
            user_id=get_effective_user_id(),
            paths=get_paths(),
            can_manage_public=getattr(get_current_user(), "system_role", None) == "admin",
        )
        return {"agents": await asyncio.to_thread(service.list_agents)}
    except Exception as exc:
        logger.exception("Failed to load the local Agent catalog")
        raise HTTPException(status_code=500, detail="Failed to load the local Agent catalog") from exc
