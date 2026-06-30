# Roadmap

Ordered roughly easiest to hardest. Items marked Planned are committed
direction; everything else is Proposed. This is direction, not a dated
commitment. What ships lives in the [README](README.md) and is described there
in present tense.

### Agents deployed by default

Status: Planned

Done:

- The forming/deployed lifecycle exists today: a new agent starts forming, interviews its human, and only acts unattended after `/deploy`, the single human-held latch. The `deploy` tool writes the agent's purpose and SOUL.md; the UI flips `deployedAt` after a y/n confirmation.

Remaining:

- Remove the forming/deployed distinction. Agents are no longer flagged deployed or non-deployed; the forming experience and the `/deploy` latch go away, and every agent runs on schedules and events from creation.

### Logging and log retrieval (Logger)

Status: Proposed

Done:

- Each agent runs under a local daemon supervised by launchd (macOS) or systemd (linux); the daemon already writes process stdout/stderr to disk.
- The append-only JSONL session tree captures the agent's reasoning and tool calls deterministically, so a per-conversation record already exists.

Remaining:

- A first-class log primitive the agent and human can query, not just raw daemon output scattered across files.
- Structured capture from extensions and integrations, keyed so a single run can be reconstructed.
- A query surface (tool + CLI) to fetch and filter logs while debugging an extension or integration.

### Agent as a versioned git folder

Status: Proposed

Done:

- Conversation-driven self-edit already works: the agent edits SOUL.md, MEMORY.md, and USER.md through a memory tool, and reload picks up the new state.
- The agent home (`~/.wolli/<agent>`) already holds `agent.json`, the memory files, and `skills/`, `extensions/`, `integrations/` as plain on-disk files the user owns.
- The plugin system loads extensions, skills, prompt templates, and themes from these folders today.

Remaining:

- Git versioning and transport over the agent home so human and agent co-edits land as reviewable commits with history.
- npm-style distribution of plugins from a registry, replacing manual folder copy.

### Workflows as first-class routing

Status: Proposed

Done:

- The integration event framework (event bus + integrations loader/runner) already routes channel events, e.g. an inbound Telegram message, into the agent.
- Extensions already support static registration of tools, commands, events, and UI.
- Local sandboxing (`srt` via Apple Seatbelt or bubblewrap, optional Docker) already runs untrusted code in isolation, which is what workflow steps need.

Remaining:

- Make extensions static-registration only; move everything dynamic into workflows whose steps run in sandboxes.
- Disassemble what an extension statically owns into per-type folders in the agent home, e.g. tools into `tools/` alongside the existing `skills/`, so each capability is an addressable file the agent and human edit directly instead of one bundled extension module.
- Treat every agent action as a workflow step — a tool call becomes a workflow with steps underneath — so the unit of execution is a step the runtime runs inline locally or as a separate sandboxed/cloud job.
- Lift the channel-aware routing logic currently embedded in extensions into a default routing workflow that is itself first-class.
- Support agent-authored workflows.

### Database primitive for agents

Status: Proposed

Done:

- Narrower durable stores already exist: `integration-store`, `integration-account-storage`, and the settings managers persist structured state to disk.
- The append-only JSONL session tree is a working precedent for durable, deterministically-read data.

Remaining:

- A general-purpose, durable structured-data store with a stable tool surface that agents can read and write directly.

### UI primitives for agents

Status: Proposed

Done:

- Extensions can already emit UI, and the TUI renders agent activity.
- The event bus already carries agent events to the client.

Remaining:

- "Working UI": a view of what the agent is doing, driven purely by agent events and reconstructed independently by each client.
- Declarative, persistable components the agent can emit (e.g. "2000 kcal today") that a client either supports and renders or ignores; ignored components are not fed back into agent context.

### First-class webhook / proxy for integrations

Status: Proposed

Done:

- The integration event framework exists (loader, runner, types, onboarding) and drives the bundled Telegram integration bidirectionally.
- None for the inbound surface itself; only the outbound integration event framework above exists today.

Remaining:

- A real inbound webhook/proxy surface so integrations can receive outside events directly, beyond the two bundled integrations that exist today.

Notes:

- Generic inbound HTTP, GitHub, and WhatsApp integrations depend on this surface.

### Integration Hardening

Status: Proposed

Remaining:

- Constrain each integration to a declared set of capabilities and transports. Integrations keep events, store, and actions, but only the subset they declare, enforced rather than ambient.
- Run integrations as short-lived, sandboxed invocations instead of long-running processes: each handler executes as a workflow step with limited access, closer to a serverless function than a daemon.
- Remodel the scheduler integration to be event-triggered rather than a long-running listener.

### Durable agents

Status: Proposed

Done:

- The per-agent local daemon supervised by launchd/systemd restarts the process when it dies.
- The append-only JSONL session tree reconstructs context deterministically and resumes the latest leaf by default, so conversational state already survives a restart.

Remaining:

- Deterministic survival of in-flight runtime state across restart and migration, not just resumption of the conversation transcript.

### Durable workflows

Status: Proposed

Done:

- No direct scaffolding yet; depends on workflows as first-class routing. The session tree's deterministic replay is the model to follow.

Remaining:

- Workflow runs survive restarts and resume deterministically from where they stopped.

### Durable integrations

Status: Proposed

Done:

- `integration-store` and `integration-account-storage` already persist integration config and account state.
- The bundled Telegram and cron scheduler integrations run as long-lived listeners today.

Remaining:

- Integration listeners and their state survive restarts and resume deterministically.

### Split `@opsyhq/wolli` into packages

Status: Planned

Done:

- The monorepo already splits out `@opsyhq/agent` (engine) and `@opsyhq/tui`. But `@opsyhq/wolli` is still one tangled package holding the agent client (`client.ts`), the agent server (`server.ts` + `AgentRuntime` + `AgentSession`), the environments (`host`/srt/docker), and the management/spawner (`AgentSettingsManager` + `ServiceManager`).

Remaining:

- Split `@opsyhq/wolli` into separate packages along those boundaries — agent client, agent server, environment, management/spawner — moving each piece to where it belongs.

Notes:

- This is the groundwork for later remote/cloud hosting (a remote agent server, a configurable transport). Those abstractions come after the split, not as part of it.

### Build-time compilation and testing of extensions and integrations

Status: Planned

Done:

- Local sandboxing (`srt`, optional Docker) already exists to run untrusted code in isolation.
- The pnpm + TypeScript monorepo build toolchain, the extension/integration loaders that compile and load TS modules, and the vitest harness are all in place.

Remaining:

- A build-time compile and self-test loop the agent runs against extensions and integrations it has authored, so it can validate them before handing them to the user.
