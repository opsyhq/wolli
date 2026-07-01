# Roadmap

Ordered roughly easiest to hardest. Items marked Planned are committed
direction; everything else is Proposed. This is direction, not a dated
commitment. Each item gives one line of where things stand today; the bullets
are the work. What ships lives in the [README](README.md) and is described
there in present tense.

### Agents deployed by default

Status: Planned

Today: a new agent forms — it interviews its human, pinned to its single birth session — until the human confirms deploy; the daemon then flips `deployedAt` and installs the OS service unit. Events and schedules are not actually gated on deployment.

Remaining:

- Remove the forming/deployed distinction: drop the `deployedAt` latch, the birth-session pin, and the forming-only deploy tool, and install the service unit at creation so every agent runs on schedules and events from birth. Rehome purpose and SOUL.md authoring, which the deploy tool owns today.

### Logging and log retrieval (Logger)

Status: Proposed

Today: only launchd redirects daemon stdout/stderr to files (in the OS temp dir); systemd output goes to journald, and unsupervised daemons (forming agents, the `none` backend) discard output entirely. The JSONL session tree already records reasoning and tool calls per conversation.

Remaining:

- A first-class log primitive the agent and human can query — durable, not launchd temp files or journald.
- Structured capture from extensions and integrations, keyed so a single run can be reconstructed.
- A query surface (tool + CLI) to fetch and filter logs while debugging an extension or integration.

### Agent as a versioned git folder

Status: Proposed

Today: the agent home (`~/.wolli/agents/<name>`) is plain on-disk files the user owns — `agent.json`, the memory files, and `extensions/`, `integrations/`, `skills/`, `prompts/`, `themes/` — and the agent already self-edits it (memory tool for MEMORY.md/USER.md, file tools for SOUL.md; edits apply next session). Plugins install from `npm:`, `git:`, and local sources into a managed per-agent store.

Remaining:

- Git versioning and transport over the agent home so human and agent co-edits land as reviewable commits with history. Nothing in the home is a git repository today (plugin stores are `.gitignore`d).
- Finish plugin distribution. Installs work mechanically, but there is no discovery surface (no registry index, search, or browse — you must already know the source), no publish flow (wolli only consumes packages; the agent cannot package and publish a plugin it authored), and no agent-facing install (the agent must ask its human to run the CLI).

### Workflows as first-class routing

Status: Proposed

Today: the integration runner routes channel events into the agent through each integration's paired chat extension; extensions register tools, commands, events, and UI — including dynamically mid-session; srt sandboxing confines writes only (reads and network are unrestricted), with full isolation Docker-only.

Remaining:

- Make extensions static-registration only; move everything dynamic (including today's mid-session tool and provider registration) into workflows whose steps run in sandboxes.
- Disassemble what an extension statically owns into per-type folders in the agent home, e.g. tools into `tools/` alongside the existing `skills/`, so each capability is an addressable file the agent and human edit directly instead of one bundled extension module.
- Treat every agent action as a workflow step — a tool call becomes a workflow with steps underneath — so the unit of execution is a step the runtime runs inline locally or as a separate sandboxed/cloud job.
- Lift the channel-aware routing logic currently embedded in the paired chat extensions into a default routing workflow that is itself first-class.
- Support agent-authored workflows.

### Database primitive for agents

Status: Proposed

Today: several narrow durable stores exist (integration store and account storage, settings, auth, approvals), and each integration gets a scoped key-value store the agent drives only indirectly through integration actions.

Remaining:

- A general-purpose, durable structured-data store with a stable tool surface that agents can read and write directly.

### UI primitives for agents

Status: Proposed

Today: extensions emit UI over a small serialized daemon protocol (awaited dialogs plus notify, status, widgets), clients reconstruct live activity independently from per-session SSE with snapshot and replay, and persisted custom messages exist — but their renderers are not wired over the daemon and they are fed back into agent context.

Remaining:

- "Working UI": extend the per-client, event-driven reconstruction into a full view of what the agent is doing.
- Declarative, persistable components the agent can emit (e.g. "2000 kcal today") that a client either supports and renders or ignores; ignored components are not fed back into agent context — today custom messages always are.

### First-class webhook / proxy for integrations

Status: Proposed

Today: the three bundled integrations all pull or hold connections (Telegram long-polls, Discord holds a gateway WebSocket, the scheduler ticks); the daemon's HTTP/SSE server has bearer auth and can bind beyond loopback, but serves only attached clients.

Remaining:

- A real inbound webhook/proxy surface so integrations can receive outside events directly instead of long-polling or holding gateway connections open.

Notes:

- Generic inbound HTTP, GitHub, and WhatsApp integrations depend on this surface.

### Integration Hardening

Status: Proposed

Today: integrations declare account, event, and action schemas that are enforced at the ctx boundary (undeclared events rejected, params and accounts validated, store scoped per service), but the module itself runs in-process with full Node authority.

Remaining:

- Constrain each integration to its declared capabilities and transports at the process boundary, enforced rather than ambient.
- Run integrations as short-lived, sandboxed invocations instead of long-lived in-process producers: each handler executes as a workflow step with limited access, closer to a serverless function than a daemon.
- Remodel the scheduler integration (today a 60-second tick loop) to be event-triggered rather than a long-running listener.

### Durable agents

Status: Proposed

Today: a deployed agent's daemon restarts on death and at boot via launchd/systemd, and sessions rebuild deterministically from the JSONL tree — a crash loses only the currently streaming message and in-memory queues.

Remaining:

- Deterministic survival of in-flight runtime state across restart and migration, not just resumption of the conversation transcript.

### Durable workflows

Status: Proposed

Today: nothing exists; depends on workflows as first-class routing. The session tree's deterministic replay is the model to follow.

Remaining:

- Workflow runs survive restarts and resume deterministically from where they stopped.

### Durable integrations

Status: Proposed

Today: integration config and account state persist and producers restart from them; the scheduler already resumes deterministically (jobs persist before their event fires, a catch-up tick runs each overdue job exactly once), but channel listeners keep no cursor — Telegram drops updates sent while offline.

Remaining:

- Channel listener state survives restarts and resumes deterministically, the way scheduler jobs already do.

### Split `@opsyhq/wolli` into packages

Status: Planned

Today: `@opsyhq/agent` (engine) and `@opsyhq/tui` are split out, but `@opsyhq/wolli` still bundles the agent client (`client.ts`), the agent server (`server.ts` + `AgentRuntime` + `AgentSession`), the environments (`host`, the srt-confined `local-os`, `docker`), the management/spawner (`AgentSettingsManager` + `ServiceManager`), and beyond those the extension, integration, and plugin systems, the built-in tool suite, themes, the model registry, auth, and approvals.

Remaining:

- Split `@opsyhq/wolli` into separate packages along those boundaries, placing the unassigned systems as well. The client/spawner boundary currently cuts through `client.ts`: it spawns daemons and drives the `ServiceManager` during deploy, restart, and delete.

Notes:

- This is the groundwork for later remote/cloud hosting (a remote agent server, a configurable transport). Those abstractions come after the split, not as part of it — though seams exist already: the in-process SDK facade and the session-namespaced HTTP/SSE wire protocol.

### Build-time compilation and testing of extensions and integrations

Status: Planned

Today: the loaders compile TS on import via jiti and report load errors and cross-extension conflicts as structured diagnostics; sandboxing and the vitest harness exist. Nothing validates at build time.

Remaining:

- A build-time compile and self-test loop the agent runs against extensions and integrations it has authored, so it can validate them before handing them to the user.
