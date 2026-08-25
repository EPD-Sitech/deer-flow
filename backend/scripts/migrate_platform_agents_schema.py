#!/usr/bin/env python
"""Migrate the legacy platform_agents table to an agent-id metadata table.

The legacy table duplicated runtime ownership and content:

    (user_id, deerflow_agent_name) -> agents(user_id, name)
    config, soul

The new table keeps only platform metadata and references the stable
``agents.id`` value. Runtime config and SOUL are always read from ``agents``.

This script is intentionally separate from the file-agent import script. Run
it once against an installation whose agents have already been imported.
"""

from __future__ import annotations

import argparse
import os
import re

from sqlalchemy import create_engine, text

SCHEMA_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
DEFAULT_SCHEMA = "deerflow"
DEFAULT_URL = "postgresql://deerflow:deerflow@10.31.174.21:5432/deerflow"


def _normalize_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    return url


def _validate_schema(schema: str) -> str:
    if not SCHEMA_RE.fullmatch(schema):
        raise ValueError(f"Invalid PostgreSQL schema: {schema!r}")
    return schema


def _table(schema: str, name: str) -> str:
    return f"{schema}.{name}"


def _table_exists(conn, schema: str, name: str) -> bool:
    return bool(
        conn.execute(
            text(
                """
                select exists (
                    select 1
                    from information_schema.tables
                    where table_schema = :schema
                      and table_name = :name
                )
                """
            ),
            {"schema": schema, "name": name},
        ).scalar_one()
    )


def _columns(conn, schema: str, name: str) -> set[str]:
    rows = conn.execute(
        text(
            """
            select column_name
            from information_schema.columns
            where table_schema = :schema
              and table_name = :name
            """
        ),
        {"schema": schema, "name": name},
    )
    return {str(row.column_name) for row in rows}


def _create_platform_table(conn, schema: str) -> None:
    agents = _table(schema, "agents")
    platform = _table(schema, "platform_agents")
    conn.execute(
        text(
            f"""
            create table {platform} (
                id uuid primary key default gen_random_uuid(),
                agent_id varchar(64) not null,
                display_name text not null,
                avatar_url text,
                tags text[] not null default '{{}}',
                status varchar(32) not null default 'active',
                visibility varchar(32) not null default 'private',
                metadata jsonb not null default '{{}}'::jsonb,
                published_at timestamptz,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now(),
                constraint uq_platform_agents_agent_id_v2 unique (agent_id),
                constraint ck_platform_agents_display_name_not_blank_v2
                    check (btrim(display_name) <> ''),
                constraint ck_platform_agents_status_v2
                    check (status in ('draft', 'active', 'disabled', 'archived')),
                constraint ck_platform_agents_visibility_v2
                    check (visibility in ('private', 'team', 'public')),
                constraint fk_platform_agents_agent_v2
                    foreign key (agent_id)
                    references {agents}(id)
                    on update cascade
                    on delete cascade
            )
            """
        )
    )
    conn.execute(
        text(
            f"""
            create index ix_platform_agents_v2_status
            on {platform} (status)
            """
        )
    )
    conn.execute(
        text(
            f"""
            create index ix_platform_agents_v2_visibility
            on {platform} (visibility)
            """
        )
    )
    conn.execute(
        text(
            f"""
            create index ix_platform_agents_v2_tags
            on {platform} using gin (tags)
            """
        )
    )
    conn.execute(
        text(
            f"""
            create index ix_platform_agents_v2_metadata
            on {platform} using gin (metadata)
            """
        )
    )
    conn.execute(
        text(
            f"""
            create or replace function {schema}.platform_agents_touch_updated_at_v2()
            returns trigger
            language plpgsql
            as $$
            begin
                new.updated_at = now();
                return new;
            end;
            $$
            """
        )
    )
    conn.execute(
        text(
            f"""
            create trigger trg_platform_agents_touch_updated_at_v2
            before update on {platform}
            for each row
            execute function {schema}.platform_agents_touch_updated_at_v2()
            """
        )
    )


def _normalize_current_platform_table(conn, schema: str) -> str:
    """Remove columns from the intermediate agent-id table that duplicate agents."""

    platform = _table(schema, "platform_agents")
    columns = _columns(conn, schema, "platform_agents")
    required = {
        "id",
        "agent_id",
        "display_name",
        "avatar_url",
        "tags",
        "status",
        "visibility",
        "metadata",
        "published_at",
        "created_at",
        "updated_at",
    }
    missing = sorted(required - columns)
    if missing:
        raise RuntimeError(f"{platform} uses an incomplete agent_id schema; missing columns: {', '.join(missing)}")

    for duplicate_column in ("user_id", "deerflow_agent_name", "config", "soul", "description", "category"):
        if duplicate_column in columns:
            conn.execute(text(f"alter table {platform} drop column {duplicate_column} cascade"))
    conn.execute(text(f"drop index if exists {schema}.ix_platform_agents_category"))
    return "normalized-existing-agent-id-table"


def migrate(conn, schema: str, *, allow_missing: bool) -> str:
    agents = _table(schema, "agents")
    platform = _table(schema, "platform_agents")
    legacy = _table(schema, "platform_agents_legacy")

    if not _table_exists(conn, schema, "agents"):
        raise RuntimeError(f"{agents} does not exist; start Gateway and run its DB migrations first")

    if not _table_exists(conn, schema, "platform_agents"):
        _create_platform_table(conn, schema)
        return "created"

    columns = _columns(conn, schema, "platform_agents")
    if "agent_id" in columns:
        return _normalize_current_platform_table(conn, schema)
    if "deerflow_agent_name" not in columns or "user_id" not in columns:
        raise RuntimeError("platform_agents is neither the known legacy schema nor the new schema")
    if _table_exists(conn, schema, "platform_agents_legacy"):
        raise RuntimeError(f"{legacy} already exists; inspect it before retrying")

    invalid_count = int(
        conn.execute(
            text(
                f"""
                select count(*)
                from {platform} p
                left join {agents} a
                  on a.user_id = p.user_id
                 and a.name = p.deerflow_agent_name
                where p.deerflow_agent_name is null
                   or a.id is null
                """
            )
        ).scalar_one()
    )
    if invalid_count and not allow_missing:
        raise RuntimeError(f"{platform} contains {invalid_count} row(s) without a matching agents row; repair them first or rerun with --allow-missing-runtime")

    conn.execute(text(f"alter table {platform} rename to platform_agents_legacy"))
    _create_platform_table(conn, schema)
    conn.execute(
        text(
            f"""
            insert into {platform} (
                id, agent_id, display_name, avatar_url,
                tags, status, visibility, metadata, published_at, created_at, updated_at
            )
            select p.id,
                   a.id,
                   p.display_name,
                   p.avatar_url,
                   coalesce(p.tags, '{{}}'::text[]),
                   coalesce(p.status, 'active'),
                   coalesce(p.visibility, 'private'),
                   coalesce(p.metadata, '{{}}'::jsonb),
                   p.published_at,
                   coalesce(p.created_at, now()),
                   coalesce(p.updated_at, now())
            from {legacy} p
            join {agents} a
              on a.user_id = p.user_id
             and a.name = p.deerflow_agent_name
            on conflict (agent_id) do update set
                display_name = excluded.display_name,
                avatar_url = excluded.avatar_url,
                tags = excluded.tags,
                status = excluded.status,
                visibility = excluded.visibility,
                metadata = excluded.metadata,
                published_at = excluded.published_at,
                updated_at = now()
            """
        )
    )
    return f"migrated; legacy backup retained as {legacy}; skipped invalid rows: {invalid_count}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refactor platform_agents to reference agents.id.")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL") or DEFAULT_URL)
    parser.add_argument("--schema", default=os.getenv("POSTGRES_SCHEMA") or DEFAULT_SCHEMA)
    parser.add_argument("--dry-run", action="store_true", help="Inspect the schema without changing it.")
    parser.add_argument(
        "--allow-missing-runtime",
        action="store_true",
        help="Skip legacy metadata rows whose (user_id, name) has no agents row.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    schema = _validate_schema(args.schema)
    engine = create_engine(_normalize_url(args.database_url), future=True, pool_pre_ping=True)
    with engine.begin() as conn:
        if args.dry_run:
            if not _table_exists(conn, schema, "platform_agents"):
                print("platform_agents does not exist; migration would create the new schema.")
            elif "agent_id" in _columns(conn, schema, "platform_agents"):
                print("platform_agents uses the agent_id schema; migration will remove duplicate columns if present.")
            else:
                print("platform_agents uses the legacy composite-key schema; migration is required.")
            return 0
        result = migrate(conn, schema, allow_missing=args.allow_missing_runtime)
        print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
