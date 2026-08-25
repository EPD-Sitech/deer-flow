#!/usr/bin/env python
"""Import file-backed DeerFlow agents into DB storage plus platform catalog.

This is an operator script for installations that used Chinese or other
human-facing directory names for custom agents. DeerFlow's DB-backed runtime
agent key must stay ASCII-ish (``^[a-z0-9-]+$``), so this script separates:

- ``deerflow.agents.name``: runnable internal name, e.g. ``agent-15562...``
- ``deerflow.platform_agents.display_name``: UI name, e.g. ``公众号运营智能体``

It handles both:

- public legacy agents under ``{DEER_FLOW_HOME}/agents``
- per-user agents under ``{DEER_FLOW_HOME}/users/{user_id}/agents``

For public agents, existing safe symlinks such as
``agent-15562e852915f2f4 -> 公众号运营智能体`` are used as the internal/display
mapping. For user agents without such symlinks, a deterministic internal name
``agent-<sha256(user_id/display_name)[:16]>`` is generated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml
from sqlalchemy import create_engine, text

SAFE_AGENT_NAME_RE = re.compile(r"^[a-z0-9-]+$")
DEFAULT_SCHEMA = "deerflow"
DEFAULT_BASE_DIR = "/oncon/data/deer-flow"
DEFAULT_USER_ID = "default"


@dataclass(frozen=True)
class AgentImport:
    user_id: str
    internal_name: str
    display_name: str
    source_path: Path
    config: dict[str, Any]
    soul: str
    visibility: Literal["public", "private"]
    source_kind: str
    generated_name: bool


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _normalise_db_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _safe_internal_name(raw: str) -> str | None:
    name = raw.lower()
    if SAFE_AGENT_NAME_RE.fullmatch(name):
        return name
    return None


def _generated_internal_name(user_id: str, display_name: str) -> str:
    digest = hashlib.sha256(f"{user_id}/{display_name}".encode()).hexdigest()[:16]
    return f"agent-{digest}"


def _load_agent_files(path: Path, *, internal_name: str) -> tuple[dict[str, Any], str]:
    config_path = path / "config.yaml"
    if not config_path.is_file():
        raise FileNotFoundError(f"missing config.yaml: {config_path}")

    loaded = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"config.yaml must contain a YAML object: {config_path}")

    config = dict(loaded)
    # Store the row key as the canonical name. SqlAgentStore strips name from
    # stored documents, and parse_agent_config will restore the row name later.
    config.pop("name", None)

    soul_path = path / "SOUL.md"
    soul = soul_path.read_text(encoding="utf-8").strip() if soul_path.is_file() else ""
    return config, soul


def _display_name_from_symlink(link: Path) -> str:
    target = os.readlink(link)
    return Path(target).name


def _iter_scope_agents(
    agents_dir: Path,
    *,
    user_id: str,
    visibility: Literal["public", "private"],
) -> tuple[list[AgentImport], list[str]]:
    imports: list[AgentImport] = []
    warnings: list[str] = []
    imported_real_paths: set[Path] = set()

    if not agents_dir.is_dir():
        return imports, warnings

    # First pass: safe-name symlinks are authoritative mappings, e.g.
    # agent-xxx -> 中文目录. Their targets should not be imported a second time.
    for entry in sorted(agents_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_symlink():
            continue
        internal_name = _safe_internal_name(entry.name)
        if internal_name is None:
            warnings.append(f"skip symlink with unsafe internal name: {entry}")
            continue
        display_name = _display_name_from_symlink(entry)
        try:
            config, soul = _load_agent_files(entry, internal_name=internal_name)
        except Exception as exc:  # noqa: BLE001 - report and continue
            warnings.append(f"skip {entry.name} -> {display_name}: {exc}")
            continue
        try:
            imported_real_paths.add(entry.resolve(strict=True))
        except OSError:
            pass
        imports.append(
            AgentImport(
                user_id=user_id,
                internal_name=internal_name,
                display_name=display_name,
                source_path=entry,
                config=config,
                soul=soul,
                visibility=visibility,
                source_kind="symlink",
                generated_name=False,
            )
        )

    # Second pass: ordinary directories. Safe names are kept; unsafe names get
    # deterministic generated internal names. Directories already reached by a
    # symlink are skipped to avoid duplicate public rows.
    for entry in sorted(agents_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_dir() or entry.is_symlink():
            continue
        try:
            if entry.resolve(strict=True) in imported_real_paths:
                continue
        except OSError:
            pass
        if not (entry / "config.yaml").is_file():
            continue

        display_name = entry.name
        internal_name = _safe_internal_name(entry.name)
        generated = internal_name is None
        if internal_name is None:
            internal_name = _generated_internal_name(user_id, display_name)

        try:
            config, soul = _load_agent_files(entry, internal_name=internal_name)
        except Exception as exc:  # noqa: BLE001 - report and continue
            warnings.append(f"skip {entry}: {exc}")
            continue

        imports.append(
            AgentImport(
                user_id=user_id,
                internal_name=internal_name,
                display_name=display_name,
                source_path=entry,
                config=config,
                soul=soul,
                visibility=visibility,
                source_kind="directory",
                generated_name=generated,
            )
        )

    return imports, warnings


def discover_agents(base_dir: Path, *, default_user_id: str) -> tuple[list[AgentImport], list[str]]:
    all_imports: list[AgentImport] = []
    warnings: list[str] = []

    public_imports, public_warnings = _iter_scope_agents(
        base_dir / "agents",
        user_id=default_user_id,
        visibility="public",
    )
    all_imports.extend(public_imports)
    warnings.extend(public_warnings)

    users_dir = base_dir / "users"
    if users_dir.is_dir():
        for user_dir in sorted(users_dir.iterdir(), key=lambda p: p.name):
            if not user_dir.is_dir():
                continue
            user_imports, user_warnings = _iter_scope_agents(
                user_dir / "agents",
                user_id=user_dir.name,
                visibility="private",
            )
            all_imports.extend(user_imports)
            warnings.extend(user_warnings)

    # Protect the database unique key before writing so a deterministic generated
    # name collision is reported clearly.
    seen: dict[tuple[str, str], AgentImport] = {}
    deduped: list[AgentImport] = []
    for item in all_imports:
        key = (item.user_id, item.internal_name)
        previous = seen.get(key)
        if previous is not None:
            warnings.append(f"duplicate internal name {item.user_id}/{item.internal_name}: keep {previous.source_path}, skip {item.source_path}")
            continue
        seen[key] = item
        deduped.append(item)

    return deduped, warnings


def ensure_platform_table(conn, schema: str) -> None:
    existing_columns = {
        str(row.column_name)
        for row in conn.execute(
            text(
                """
                select column_name
                from information_schema.columns
                where table_schema = :schema and table_name = 'platform_agents'
                """
            ),
            {"schema": schema},
        )
    }
    if existing_columns and {"description", "category"} & existing_columns:
        raise RuntimeError(f"{schema}.platform_agents still has legacy duplicate columns; run migrate_platform_agents_schema.py before importing agents")
    conn.execute(
        text(f"""
        create table if not exists {schema}.platform_agents (
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
            constraint ck_platform_agents_display_name_not_blank_v2 check (btrim(display_name) <> ''),
            constraint ck_platform_agents_status_v2 check (status in ('draft', 'active', 'disabled', 'archived')),
            constraint ck_platform_agents_visibility_v2 check (visibility in ('private', 'team', 'public')),
            constraint uq_platform_agents_agent_id_v2 unique (agent_id),
            constraint fk_platform_agents_agent_v2
                foreign key (agent_id)
                references {schema}.agents (id)
                on update cascade
                on delete cascade
        )
    """)
    )
    conn.execute(
        text(f"""
        create index if not exists ix_platform_agents_v2_agent_id
        on {schema}.platform_agents (agent_id)
    """)
    )
    conn.execute(text(f"create index if not exists ix_platform_agents_v2_status on {schema}.platform_agents (status)"))
    conn.execute(text(f"create index if not exists ix_platform_agents_v2_visibility on {schema}.platform_agents (visibility)"))
    conn.execute(text(f"create index if not exists ix_platform_agents_v2_tags on {schema}.platform_agents using gin (tags)"))
    conn.execute(text(f"create index if not exists ix_platform_agents_v2_metadata on {schema}.platform_agents using gin (metadata)"))
    conn.execute(
        text(f"""
        create or replace function {schema}.platform_agents_touch_updated_at_v2()
        returns trigger
        language plpgsql
        as $$
        begin
            new.updated_at = now();
            return new;
        end;
        $$
    """)
    )
    conn.execute(
        text(f"""
        do $$
        begin
            if not exists (
                select 1 from pg_trigger
                where tgname = 'trg_platform_agents_touch_updated_at_v2'
            ) then
                create trigger trg_platform_agents_touch_updated_at_v2
                before update on {schema}.platform_agents
                for each row
                execute function {schema}.platform_agents_touch_updated_at_v2();
            end if;
        end;
        $$
    """)
    )


def verify_agents_table(conn, schema: str) -> None:
    exists = conn.execute(
        text(
            """
            select exists (
                select 1
                from information_schema.tables
                where table_schema = :schema and table_name = 'agents'
            )
            """
        ),
        {"schema": schema},
    ).scalar_one()
    if not exists:
        raise RuntimeError(f"{schema}.agents does not exist. Start Gateway once or run DeerFlow DB migrations first.")


def upsert_agent(conn, schema: str, item: AgentImport, *, overwrite: bool) -> None:
    metadata = {
        "source": "file-agent-migration",
        "source_kind": item.source_kind,
        "source_path": str(item.source_path),
        "original_name": item.display_name,
        "generated_name": item.generated_name,
    }
    if overwrite:
        agents_sql = f"""
            insert into {schema}.agents (id, user_id, name, config, soul, created_at, updated_at)
            values (:id, :user_id, :name, cast(:config_json as json), :soul, now(), now())
            on conflict (user_id, name) do update set
                config = excluded.config,
                soul = excluded.soul,
                updated_at = now()
        """
        platform_sql = f"""
            insert into {schema}.platform_agents (
                agent_id, display_name,
                status, visibility, metadata
            )
            select a.id, :display_name,
                   'active', :visibility, cast(:metadata_json as jsonb)
            from {schema}.agents a
            where a.user_id = :user_id and a.name = :name
            on conflict (agent_id)
            do update set
                display_name = excluded.display_name,
                status = 'active',
                visibility = excluded.visibility,
                metadata = excluded.metadata
        """
    else:
        agents_sql = f"""
            insert into {schema}.agents (id, user_id, name, config, soul, created_at, updated_at)
            values (:id, :user_id, :name, cast(:config_json as json), :soul, now(), now())
            on conflict (user_id, name) do nothing
        """
        platform_sql = f"""
            insert into {schema}.platform_agents (
                agent_id, display_name,
                status, visibility, metadata
            )
            select a.id, :display_name,
                   'active', :visibility, cast(:metadata_json as jsonb)
            from {schema}.agents a
            where a.user_id = :user_id and a.name = :name
            on conflict (agent_id)
            do nothing
        """

    params = {
        "id": uuid.uuid4().hex,
        "user_id": item.user_id,
        "name": item.internal_name,
        "display_name": item.display_name,
        "soul": item.soul,
        "visibility": item.visibility,
        "config_json": _json(item.config),
        "metadata_json": _json(metadata),
    }
    conn.execute(text(agents_sql), params)
    conn.execute(text(platform_sql), params)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import Chinese/display-name DeerFlow file agents into deerflow.agents and deerflow.platform_agents.")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"), help="PostgreSQL URL. Defaults to DATABASE_URL.")
    parser.add_argument("--schema", default=DEFAULT_SCHEMA, help="PostgreSQL schema. Default: deerflow.")
    parser.add_argument(
        "--base-dir",
        default=os.getenv("DEER_FLOW_HOME") or DEFAULT_BASE_DIR,
        help="DeerFlow data directory. Default: DEER_FLOW_HOME or /oncon/data/deer-flow.",
    )
    parser.add_argument("--default-user-id", default=DEFAULT_USER_ID, help="Owner for legacy public agents. Default: default.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned imports without writing.")
    parser.add_argument("--no-overwrite", action="store_true", help="Do not update existing DB rows.")
    parser.add_argument("--skip-platform-ddl", action="store_true", help="Do not create/verify platform_agents table.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.database_url:
        print("DATABASE_URL is required. Pass --database-url or set DATABASE_URL.", file=sys.stderr)
        return 2

    base_dir = Path(args.base_dir)
    imports, warnings = discover_agents(base_dir, default_user_id=args.default_user_id)

    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)

    if not imports:
        print(f"No agents found under {base_dir}")
        return 0

    print(f"Discovered {len(imports)} agent(s) under {base_dir}:")
    for item in imports:
        marker = "generated" if item.generated_name else item.source_kind
        print(f"  {item.user_id}/{item.internal_name} -> {item.display_name} [{item.visibility}, {marker}, {item.source_path}]")

    if args.dry_run:
        print("Dry run only; no database writes performed.")
        return 0

    engine = create_engine(_normalise_db_url(args.database_url), connect_args={"connect_timeout": 10})
    with engine.begin() as conn:
        verify_agents_table(conn, args.schema)
        if not args.skip_platform_ddl:
            ensure_platform_table(conn, args.schema)
        for item in imports:
            upsert_agent(conn, args.schema, item, overwrite=not args.no_overwrite)

    print(f"Imported/updated {len(imports)} agent(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
