# Authenticated Agent Sharing

## Behavior

Agent sharing now uses the same public-Agent and chat behavior that regular
signed-in users already use inside the platform. A share URL is only an entry
point: unauthenticated visitors are sent to the existing login page, and after
login they are redirected to the existing
`/workspace/agents/{runtime-name}/chats/new` route.

There is no guest role, separate public chat layout, or reduced composer.
Attachments, voice input, prompt optimization, modes, model selection, guide
questions, navigation, and account permissions therefore remain identical to
the visitor's normal signed-in experience.

## Permissions

Only administrators can enable or disable sharing. They may share a platform
Agent or one of their own custom Agents. Regular users cannot share Agents.

An administrator's shared custom Agent is published through the existing
platform Agent store. Regular users consequently see it as an ordinary public
Agent: they can inspect its standard read-only details and start a chat, but
cannot edit, delete, share, export, clone, schedule, debug, version, or
batch-manage it. Disabling the share removes only the public copy created by
that share and leaves the administrator's custom Agent intact.

Existing public Agent names are never overwritten. Enabling a custom-Agent
share returns a conflict if that name is already occupied by an independently
managed public Agent. Older share-registry entries are upgraded to the same
standard public-Agent representation when they are resolved.

## Implementation Boundary

The publishing and permission logic remains under
`backend/app/gateway/agent_management/`. The two existing public-link pages now
perform authentication and redirect only; they do not render a separate chat
component. The native Agent chat page and input components are unchanged.

No dependency manifests, runtime `config.yaml`, README files, or AGENTS guides
are changed by this iteration.
