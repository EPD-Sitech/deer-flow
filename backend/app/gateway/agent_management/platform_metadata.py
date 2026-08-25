from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine, bindparam, create_engine, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from deerflow.config.app_config import get_app_config

logger = logging.getLogger(__name__)

_engines: dict[str, Engine] = {}
_engines_lock = threading.Lock()


@dataclass(frozen=True)
class PlatformAgentMetadata:
    """Joined platform metadata plus the runtime identity used by callers."""

    user_id: str
    deerflow_agent_name: str
    display_name: str
    visibility: str
    status: str


def _engine(url: str) -> Engine:
    engine = _engines.get(url)
    if engine is not None:
        return engine
    with _engines_lock:
        engine = _engines.get(url)
        if engine is None:
            connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
            engine = create_engine(url, future=True, pool_pre_ping=True, connect_args=connect_args)
            _engines[url] = engine
        return engine


def _qualified_table(schema: str) -> str:
    return f"{schema}.platform_agents" if schema else "platform_agents"


def _qualified_agents_table(schema: str) -> str:
    return f"{schema}.agents" if schema else "agents"


def _database_identity() -> tuple[str, str] | None:
    try:
        config = get_app_config()
    except Exception:  # noqa: BLE001 - lightweight/test contexts may not load config
        return None
    if config.database.backend not in {"sqlite", "postgres"}:
        return None
    schema = config.database.postgres_schema if config.database.backend == "postgres" else ""
    return config.database.app_sync_sqlalchemy_url, schema


def get_platform_agent_display_names(
    user_id: str,
    agent_names: Iterable[str],
) -> dict[str, str]:
    names = sorted({name for name in agent_names if name})
    if not names:
        return {}
    identity = _database_identity()
    if identity is None:
        return {}
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).connect() as conn:
            stmt = text(
                f"""
                    select a.name as deerflow_agent_name, p.display_name
                    from {table} p
                    join {agents} a on a.id = p.agent_id
                    where a.user_id = :user_id
                      and a.name in :names
                      and p.display_name is not null
                    """
            ).bindparams(bindparam("names", expanding=True))
            rows = conn.execute(
                stmt,
                {"user_id": user_id, "names": names},
            )
            return {str(row.deerflow_agent_name): str(row.display_name) for row in rows}
    except SQLAlchemyError:
        logger.debug("platform_agents display-name lookup failed", exc_info=True)
        return {}


def get_public_platform_agent_owner(agent_name: str) -> str | None:
    identity = _database_identity()
    if identity is None:
        return None
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).connect() as conn:
            row = conn.execute(
                text(
                    f"""
                    select a.user_id
                    from {table} p
                    join {agents} a on a.id = p.agent_id
                    where a.name = :agent_name
                      and p.visibility = 'public'
                      and p.status = 'active'
                    order by case when a.user_id = 'default' then 0 else 1 end,
                             p.updated_at desc
                    limit 1
                    """
                ),
                {"agent_name": agent_name},
            ).first()
            return str(row.user_id) if row is not None else None
    except SQLAlchemyError:
        logger.debug("platform_agents owner lookup failed", exc_info=True)
        return None


def get_agent_runtime_owner(agent_name: str) -> str | None:
    """Return an owner that has a real runtime row for ``agent_name``."""
    identity = _database_identity()
    if identity is None:
        return None
    url, schema = identity
    agents_table = _qualified_agents_table(schema)
    try:
        with _engine(url).connect() as conn:
            row = conn.execute(
                text(
                    f"""
                    select user_id
                    from {agents_table}
                    where name = :agent_name
                    order by case when user_id = 'default' then 0 else 1 end,
                             updated_at desc
                    limit 1
                    """
                ),
                {"agent_name": agent_name},
            ).first()
            return str(row.user_id) if row is not None else None
    except SQLAlchemyError:
        logger.debug("agents runtime owner lookup failed", exc_info=True)
        return None


def create_platform_agent_metadata(
    user_id: str,
    agent_name: str,
    display_name: str,
    *,
    visibility: str = "public",
    metadata: dict[str, Any] | None = None,
) -> None:
    identity = _database_identity()
    if identity is None:
        return
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).begin() as conn:
            conn.execute(
                text(
                    f"""
                    insert into {table} (
                        agent_id, display_name, status, visibility, metadata
                    )
                    select a.id, :display_name, 'active', :visibility,
                           cast(:metadata_json as jsonb)
                    from {agents} a
                    where a.user_id = :user_id and a.name = :agent_name
                    on conflict (agent_id)
                    do update set
                        display_name = excluded.display_name,
                        status = 'active',
                        visibility = excluded.visibility,
                        metadata = excluded.metadata
                    """
                ),
                {
                    "user_id": user_id,
                    "display_name": display_name,
                    "agent_name": agent_name,
                    "visibility": visibility,
                    "metadata_json": json.dumps(
                        metadata or {"source": "platform-management"},
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                },
            )
    except IntegrityError as exc:
        raise ValueError(f"Display name '{display_name}' is already in use") from exc
    except SQLAlchemyError as exc:
        raise ValueError("Failed to create platform Agent metadata") from exc


def delete_platform_agent_metadata(user_id: str, agent_name: str) -> bool:
    identity = _database_identity()
    if identity is None:
        return False
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).begin() as conn:
            result = conn.execute(
                text(
                    f"""
                    delete from {table} p
                    where p.agent_id = (
                        select a.id from {agents} a
                        where a.user_id = :user_id and a.name = :agent_name
                    )
                    """
                ),
                {"user_id": user_id, "agent_name": agent_name},
            )
            return result.rowcount > 0
    except SQLAlchemyError as exc:
        raise ValueError("Failed to delete platform Agent metadata") from exc


def move_agent_scope_record(
    from_user_id: str,
    to_user_id: str,
    agent_name: str,
    *,
    visibility: str,
    config: dict[str, Any],
    soul: str,
    display_name: str | None = None,
) -> bool:
    identity = _database_identity()
    if identity is None:
        return False
    url, schema = identity
    agents_table = f"{schema}.agents" if schema else "agents"
    platform_table = _qualified_table(schema)
    effective_display_name = str(display_name or config.get("display_name") or config.get("name") or agent_name)
    config_document = {key: value for key, value in config.items() if key != "name"}
    try:
        with _engine(url).begin() as conn:
            runtime_result = conn.execute(
                text(
                    f"""
                    update {agents_table}
                    set user_id = :to_user_id,
                        config = cast(:config_json as json),
                        soul = :soul,
                        updated_at = now()
                    where user_id = :from_user_id
                      and name = :agent_name
                    """
                ),
                {
                    "from_user_id": from_user_id,
                    "to_user_id": to_user_id,
                    "agent_name": agent_name,
                    "config_json": json.dumps(
                        config_document,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    "soul": soul or "",
                },
            )
            if runtime_result.rowcount <= 0:
                return False

            values = {
                "display_name": effective_display_name,
                "visibility": visibility,
            }
            metadata_result = conn.execute(
                text(
                    f"""
                    update {platform_table}
                    set display_name = coalesce(nullif(:display_name, ''), display_name),
                        visibility = :visibility,
                        status = 'active'
                    where agent_id = (
                        select a.id
                        from {agents_table} a
                        where a.user_id = :to_user_id and a.name = :agent_name
                    )
                    """
                ),
                {**values, "to_user_id": to_user_id, "agent_name": agent_name},
            )
            if metadata_result.rowcount > 0:
                return True
            values["metadata_json"] = json.dumps(
                {"source": "platform-management"},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            conn.execute(
                text(
                    f"""
                    insert into {platform_table} (
                        agent_id, display_name, status, visibility, metadata
                    )
                    select a.id, :display_name, 'active', :visibility,
                           cast(:metadata_json as jsonb)
                    from {agents_table} a
                    where a.user_id = :to_user_id and a.name = :agent_name
                    on conflict (agent_id)
                    do update set
                        display_name = excluded.display_name,
                        status = 'active',
                        visibility = excluded.visibility,
                        metadata = excluded.metadata
                    """
                ),
                {**values, "to_user_id": to_user_id, "agent_name": agent_name},
            )
            return True
    except IntegrityError as exc:
        raise ValueError(f"Agent '{agent_name}' already exists in the target scope") from exc
    except SQLAlchemyError as exc:
        raise ValueError("Failed to move Agent scope") from exc


def update_platform_agent_display_name(
    user_id: str,
    agent_name: str,
    display_name: str,
) -> bool:
    identity = _database_identity()
    if identity is None:
        return False
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).begin() as conn:
            result = conn.execute(
                text(
                    f"""
                    update {table} p
                    set display_name = :display_name
                    where p.agent_id = (
                        select a.id from {agents} a
                        where a.user_id = :user_id and a.name = :agent_name
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "agent_name": agent_name,
                    "display_name": display_name,
                },
            )
            return result.rowcount > 0
    except IntegrityError as exc:
        raise ValueError(f"Display name '{display_name}' is already in use") from exc
    except SQLAlchemyError as exc:
        raise ValueError("Failed to update Agent display name") from exc


def list_public_platform_agents() -> list[PlatformAgentMetadata]:
    identity = _database_identity()
    if identity is None:
        return []
    url, schema = identity
    table = _qualified_table(schema)
    agents = _qualified_agents_table(schema)
    try:
        with _engine(url).connect() as conn:
            rows = conn.execute(
                text(
                    f"""
                    select a.user_id,
                           a.name as deerflow_agent_name,
                           p.display_name,
                           p.visibility,
                           p.status
                    from {table} p
                    join {agents} a on a.id = p.agent_id
                    where p.visibility = 'public'
                      and p.status = 'active'
                    order by p.display_name asc
                    """
                )
            )
            return [
                PlatformAgentMetadata(
                    user_id=str(row.user_id),
                    deerflow_agent_name=str(row.deerflow_agent_name),
                    display_name=str(row.display_name),
                    visibility=str(row.visibility),
                    status=str(row.status),
                )
                for row in rows
            ]
    except SQLAlchemyError:
        logger.debug("platform_agents public catalog lookup failed", exc_info=True)
        return []


def merge_display_name(item: dict[str, Any], display_name: str | None) -> dict[str, Any]:
    if display_name and display_name != item.get("name"):
        return {**item, "display_name": display_name}
    return item
