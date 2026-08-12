# Local Agent Harness Migration

## Scope

This iteration incrementally migrates the local Agent management experience
from `ai-agent-harness` into DeerFlow. The existing DeerFlow Agent page and its
components remain unchanged. The exact `/workspace/agents` URL is rewritten to
the migrated page at `/workspace/agents/local`.

The migrated experience includes local Agent search and filtering with All,
Public, and Custom scope tabs, creation,
chat entry, import, ZIP and Markdown export, cloning, batch export and deletion,
model settings, config and SOUL editing, memory editing, version snapshots and
restore, validation and test prompts, run statistics and logs, Sub-Agent package
import, scheduled tasks, and explicit public-link sharing.

Knowledge-base integration, remote/A2A Agents, and the template marketplace are
not included.

## Frontend

Migrated code is isolated under
`frontend/src/components/workspace/agent-harness/` and
`frontend/src/app/workspace/agents/local/`. Public links use the standalone
`https://fintech.teamshub.com/agent/{public_name}` page. Sharing must be explicitly enabled; the owner can
set or reset a concise public alias, copy the link, and disable the link again.

## Backend

Incremental APIs live under `backend/app/gateway/agent_management/`. They reuse
the existing Agent Store, memory, run, skill, model, and scheduler services. The
host application mounts the incremental router, and the auth/CSRF middleware
allow unauthenticated access only under `/api/public/agents/`. Public sharing
metadata is kept outside `AgentConfig`, so the open-source Agent schema and its
file/SQL storage implementations do not need migration-specific fields.

Public Agents are read from DeerFlow's existing global Agent directory at
`{DEER_FLOW_HOME}/agents/{agent-name}/` (the default runtime home is
`.deer-flow`). Custom Agents remain under
`{DEER_FLOW_HOME}/users/{user-id}/agents/{agent-name}/`.

Migrated public Agents may use Chinese names. The management API and UI keep the
Chinese name as the display and management identity, while the migration layer
creates a deterministic `agent-{sha256-prefix}` symlink beside it for DeerFlow's
unchanged ASCII-only runtime. Chat, schedules, run statistics, and memory use
that runtime alias. Native custom Agent creation keeps the upstream
`^[A-Za-z0-9-]+$` naming rule; cloning a Chinese public Agent therefore defaults
to an ASCII target name.

The migration remains concentrated in new backend/frontend directories. Four
small host integration points are changed: Gateway router mounting, public-share
auth and CSRF exemptions, and the exact frontend route rewrite. Existing Agent
page and component files, `config.yaml`, README files, and AGENTS guides remain
unchanged.

Permission rules are enforced by both the catalog capabilities and the
management endpoints. Regular users may clone and export public Agents. Only
administrators may edit, delete, share, schedule, debug, version, or batch
select/delete public Agents. Custom Agent management remains isolated to the
current owner.

The public Agent API exposes only non-sensitive metadata and a lightweight
conversation endpoint. It never returns SOUL content or ownership information.
Public conversation uses the Agent model and SOUL but does not expose DeerFlow
tools, knowledge-base retrieval, remote Agents, or template-market behavior.

## Validation

The migration is covered by focused backend route/service tests and frontend
API/component tests. Full frontend lint, type checking, unit tests, focused
backend tests, Ruff checks, and desktop/mobile browser verification are run as
part of the iteration handoff.
