# Roadmap

Ordered roughly easiest to hardest. Only the last item, build-time compilation
and testing of extensions and integrations, is Planned right now; everything
above it is Proposed. This is direction, not a dated commitment. What ships lives
in the [README](README.md) and is described there in present tense.

### 1. Logging and log retrieval (Logger)

Status: Proposed

Done:

- Each agent runs under a local daemon supervised by launchd (macOS) or systemd (linux); the daemon already writes process stdout/stderr to disk.
- The append-only JSONL session tree captures the agent's reasoning and tool calls deterministically, so a per-conversation record already exists.

Remaining:

- A first-class log primitive the agent and human can query, not just raw daemon output scattered across files.
- Structured capture from extensions and integrations, keyed so a single run can be reconstructed.
- A query surface (tool + CLI) to fetch and filter logs while debugging an extension or integration.

### 2. Agent as a versioned git folder

Status: Proposed

Done:

- Conversation-driven self-edit already works: the agent edits SOUL.md, MEMORY.md, and USER.md through a memory tool, and reload picks up the new state.
- The agent home (`~/.wolli/<agent>`) already holds `agent.json`, the memory files, and `skills/`, `extensions/`, `integrations/` as plain on-disk files the user owns.
- The plugin system loads extensions, skills, prompt templates, and themes from these folders today.

Remaining:

- Git versioning and transport over the agent home so human and agent co-edits land as reviewable commits with history.
- npm-style distribution of plugins from a registry, replacing manual folder copy.

### 3. Workflows as first-class routing

Status: Proposed

Done:

- The integration event framework (event bus + integrations loader/runner) already routes channel events, e.g. an inbound Telegram message, into the agent.
- Extensions already support static registration of tools, commands, events, and UI.
- Local sandboxing (`srt` via Apple Seatbelt or bubblewrap, optional Docker) already runs untrusted code in isolation, which is what workflow steps need.

Remaining:

- Make extensions static-registration only; move everything dynamic into workflows whose steps run in sandboxes.
- Lift the channel-aware routing logic currently embedded in extensions into a default routing workflow that is itself first-class.
- Support agent-authored workflows.

### 4. Database primitive for agents

Status: Proposed

Done:

- Narrower durable stores already exist: `integration-store`, `integration-account-storage`, and the settings managers persist structured state to disk.
- The append-only JSONL session tree is a working precedent for durable, deterministically-read data.

Remaining:

- A general-purpose, durable structured-data store with a stable tool surface that agents can read and write directly.

### 5. UI primitives for agents

Status: Proposed

Done:

- Extensions can already emit UI, and the TUI renders agent activity.
- The event bus already carries agent events to the client.

Remaining:

- "Working UI": a view of what the agent is doing, driven purely by agent events and reconstructed independently by each client.
- Declarative, persistable components the agent can emit (e.g. "2000 kcal today") that a client either supports and renders or ignores; ignored components are not fed back into agent context.

### 6. First-class webhook / proxy for integrations

Status: Proposed

Done:

- The integration event framework exists (loader, runner, types, onboarding) and drives the bundled Telegram integration bidirectionally.
- None for the inbound surface itself; only the outbound integration event framework above exists today.

Remaining:

- A real inbound webhook/proxy surface so integrations can receive outside events directly, beyond the two bundled integrations that exist today.

Notes:

- Generic inbound HTTP, GitHub, and WhatsApp integrations depend on this surface.

### 7. Durable agents

Status: Proposed

Done:

- The per-agent local daemon supervised by launchd/systemd restarts the process when it dies.
- The append-only JSONL session tree reconstructs context deterministically and resumes the latest leaf by default, so conversational state already survives a restart.

Remaining:

- Deterministic survival of in-flight runtime state across restart and migration, not just resumption of the conversation transcript.

### 8. Durable workflows

Status: Proposed

Done:

- No direct scaffolding yet; depends on item 3 (workflows as first-class routing). The session tree's deterministic replay is the model to follow.

Remaining:

- Workflow runs survive restarts and resume deterministically from where they stopped.

### 9. Durable integrations

Status: Proposed

Done:

- `integration-store` and `integration-account-storage` already persist integration config and account state.
- The bundled Telegram and cron scheduler integrations run as long-lived listeners today.

Remaining:

- Integration listeners and their state survive restarts and resume deterministically.

### 10. Build-time compilation and testing of extensions and integrations

Status: Planned

Done:

- Local sandboxing (`srt`, optional Docker) already exists to run untrusted code in isolation.
- The pnpm + TypeScript monorepo build toolchain, the extension/integration loaders that compile and load TS modules, and the vitest harness are all in place.

Remaining:

- A build-time compile and self-test loop the agent runs against extensions and integrations it has authored, so it can validate them before handing them to the user.
