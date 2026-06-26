# SDK

The SDK provides programmatic access to a steward agent. It has two faces, and which one you reach for depends on where your code runs relative to the agent's daemon:

- **In-process embedding** — `createAgentSession()` plus the `@opsyhq/steward` barrel. You build the system prompt, model, tools, and session yourself, then drive the returned `AgentHarness` directly in your own Node process. No daemon, no HTTP. Use this when you are constructing an agent runtime from scratch (this is the layer the daemon itself is built on).
- **The daemon control protocol** — a long-running, per-agent loopback **HTTP/SSE** server (`runDaemon`) and a typed client (`Steward` / `Agent` / `SessionHandle`). Commands are JSON over `POST`, events stream as SSE, and every session is addressed by a URL path. This is steward's equivalent of an RPC transport, and it is what the `@opsyhq/cli` TUI and every OS service unit talk to. See [RPC Mode](#rpc-mode).

> Steward's RPC transport is **HTTP/SSE over a loopback socket**, not stdin/stdout JSONL. There is no `--mode rpc` subprocess. A client attaches to a running daemon over `http://127.0.0.1:<port>`; the daemon owns the agent's lifecycle and outlives any one client.

If you are building a client against an already-deployed agent, you almost always want the daemon face — start at [Quick Start](#quick-start). If you are embedding the engine itself, read [Core Concepts](#core-concepts).

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
  - [createAgentSession()](#createagentsession)
  - [AgentHarness](#agentharness)
  - [openAgentSession() and AgentRuntime (internal engine)](#openagentsession-and-agentruntime-internal-engine)
  - [Prompting and Queueing](#prompting-and-queueing)
  - [Events](#events)
- [Options Reference](#options-reference)
- [Return Value](#return-value)
- [Complete Example](#complete-example)
- [Run Modes](#run-modes)
- [Exports](#exports)
- [RPC Mode](#rpc-mode)
- [Integrations](#integrations)
- [Configuration and Environment](#configuration-and-environment)

## Quick Start

The daemon face, end to end: connect to (or spawn) an agent's daemon, open its latest session, subscribe, and prompt.

```typescript
import { Steward } from "@opsyhq/steward";

const steward = new Steward();
const agent = steward.get("my-agent"); // a handle if the agent exists on disk
if (!agent) throw new Error("Unknown agent");

// Find the live daemon (or spawn a detached one) and open the control stream.
await agent.connect();

// The daemon always keeps at least one session; open the most recent one.
const session = await agent.getLatestSession();

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What did you work on today?");
```

`prompt()` resolves the moment the prompt is **accepted** (handled, queued, or about to run), not when the turn ends. The turn streams over the session's SSE; watch for `agent_end` to know it finished.

## Installation

```bash
npm install @opsyhq/steward
```

Everything below — both faces — is re-exported from the package's barrel (`src/index.ts`). No separate install.

## Core Concepts

### createAgentSession()

The in-process builder. It constructs the high-level `AgentHarness` (the durable session tree is built in) from a **pre-built** system prompt, a model, tools, and resources.

```typescript
import { createAgentSession } from "@opsyhq/steward";

const { harness } = await createAgentSession({
  env,             // ExecutionEnv — the file/shell backend
  session,         // Session — the durable session tree (from openAgentSession())
  model,           // Model<Api>
  systemPrompt,    // string, pre-built and frozen for the session's lifetime
  modelRegistry,   // ModelRegistry — resolves request-time auth (api keys + headers)
  settingsManager, // AgentSettingsManager — read for provider-attribution headers
  sessionId,       // string — threaded into provider-attribution session headers
});
```

> Unlike pi, `createAgentSession()` returns `{ harness }` (an `AgentHarness`), **not** `{ session }`. There is no `ResourceLoader`, no `authStorage`/`cwd`/`agentDir` option, and no model fallback message. The system prompt is passed in pre-built (you call `buildSystemPrompt()` yourself); the harness re-invokes a constant callback each turn so the prefix cache stays warm.

The function resolves request-time auth through `modelRegistry.getApiKeyAndHeaders(model)` (not by reading `AuthStorage` directly), which is what carries custom `models.json` keys and per-model/provider headers, then merges in provider-attribution headers. A keyless (header-only) provider is rejected — every steward provider has an api key today.

To build the inputs `createAgentSession()` needs (`env`, `session`, plus the working `cwd`), use [`openAgentSession()`](#openagentsession-and-agentruntime-internal-engine). To build the `systemPrompt`, use [`buildSystemPrompt()`](#system-prompt).

### AgentHarness

`createAgentSession()` returns the harness — the object you drive in-process. It owns the agent lifecycle: prompting, the steer/follow-up queue, model and thinking state, compaction, and event streaming. (`AgentHarness` is from `@opsyhq/agent`; steward re-exports the pieces you build it with.)

```typescript
// Subscribe to events (returns an unsubscribe function)
const unsubscribe = harness.subscribe((event) => { /* … */ });

// Prompt and queue
await harness.steer("New instruction", { images });
await harness.followUp("After you're done, also do this", { images });
await harness.abort();
await harness.compact(customInstructions);
await harness.waitForIdle();
await harness.appendMessage(message);

// State
harness.getModel();          // Model<Api>
harness.getThinkingLevel();  // ThinkingLevel
harness.getActiveTools();    // AgentTool[]
harness.isIdle;              // boolean
```

> In-process subscription is `harness.subscribe(...)`. There is **no** `AgentSession.subscribe()` for embedders — the daemon's `AgentSession` and `AgentRuntime` are internal (see below). The public daemon-client per-session subscription is [`SessionHandle.subscribe()`](#sessionhandle).

**The harness owns the turn loop; you observe it.** A verb (`steer`/`followUp`/`appendMessage`) resolves on *acceptance*, not on turn completion — the actual response streams out through `subscribe(...)`. To run synchronously, await `harness.waitForIdle()` after queueing, then read the result off the events you collected (or off the `session` tree). Subscribe **before** you queue the first prompt, or you miss the leading deltas of that turn.

> There is **no `harness.prompt()`**. The in-process face exposes only `steer` (queue for after the current tool calls, before the next LLM call), `followUp` (queue for when the agent next stops), and `appendMessage` (push a raw message with no turn). To *start* a fresh turn on an idle harness, use `followUp(text)` — it runs immediately when the loop is idle. This is why the [Complete Example](#complete-example) opens with `harness.followUp(...)`. The single-verb `prompt(msg, { streamingBehavior })` only exists on the [daemon client](#sessionhandle), which folds the queue choice into one call.

### openAgentSession() and AgentRuntime (internal engine)

`openAgentSession(name, opts?)` is the durable-session helper. It resolves the agent's owned workspace as the cwd (sessions are keyed by agent, never by the directory you ran from), builds a `NodeExecutionEnv` and a `JsonlSessionRepo`, then opens the latest stored session, a specific one by `id`, or a fresh one.

```typescript
import { openAgentSession } from "@opsyhq/steward";

const { repo, session, env, cwd } = await openAgentSession("my-agent", {
  fresh: false, // start a new session instead of resuming the latest
  id: undefined, // resume a specific stored session id (ignored when `fresh`)
});
```

`AgentRuntime` (exported as `AgentRuntime`, `AgentRuntimeOptions`) is the **daemon's internal engine**. It owns N resident sessions keyed by id, the single extension + integration runners, the model registry, auth, reload, and cleanup. The daemon (`runDaemon`) constructs one `AgentRuntime` and wraps the [HTTP/SSE routes](#rpc-mode) around it; `AgentRuntime` is what `createAgentSession` ultimately feeds.

> `AgentRuntime` and its per-session `AgentSession` are documented here as the engine the daemon runs, **not** as an embedding path. They are not a turnkey `new AgentRuntime(...)` SDK surface — their options (`authStorage`, `integrationAccounts`, `integrationStore`, a resolved `model`) are the daemon's to assemble. To embed in-process, use `createAgentSession()` + the harness; to drive an agent remotely, use the [daemon client](#rpc-mode).

### Prompting and Queueing

On the in-process harness, prompting splits across three verbs:

- `harness.steer(message, { images })` — queue a steering message, delivered after the current assistant turn finishes its tool calls, before the next LLM call.
- `harness.followUp(message, { images })` — queue a follow-up, delivered only when the agent stops.
- `harness.appendMessage(message)` — append a raw `AgentMessage` to history without triggering a turn.

Over the [daemon client](#sessionhandle), prompting collapses onto a single `prompt()` whose `streamingBehavior` selects the queue while streaming:

```typescript
// Not streaming: a normal prompt.
await session.prompt("What files are here?");

// Streaming: choose how to queue.
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

> The daemon client steers and follows up **through `prompt(msg, { streamingBehavior })`** — there are no separate `SessionHandle.steer()` / `SessionHandle.followUp()` methods. (The daemon's own `/control` protocol does have distinct `steer` / `follow_up` commands; the typed client folds them into `prompt`.)

`prompt()` acks on acceptance via a preflight signal: success means accepted, queued, or handled immediately; rejection (e.g. an ambiguous mid-stream submit) throws. Failures after acceptance arrive through the event stream, not as a rejected `prompt()`.

### Events

Subscribe to receive streaming output and lifecycle notifications. The same `AgentHarnessEvent` union flows in-process (`harness.subscribe`) and over the daemon ([`SessionHandle.subscribe`](#sessionhandle)); the daemon forwards a **curated subset** (see [Events over the daemon](#events-1)).

```typescript
harness.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      // event.toolName, event.args
      break;
    case "tool_execution_update": // streaming tool output
    case "tool_execution_end":    // event.isError
      break;
    case "message_start":
    case "message_end":
      break;
    case "agent_start":           // agent began processing a prompt
    case "agent_end":             // agent finished (event.messages)
      break;
    case "turn_start":
    case "turn_end":              // event.message, event.toolResults
      break;
    case "queue_update":          // event.steering, event.followUp
      break;
    case "model_update":          // event.model
    case "thinking_level_update": // event.level
      break;
  }
});
```

> Steward does **not** emit `compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, or `extension_error` on the forwarded stream. It **does** add `model_update`, `thinking_level_update`, and (over the daemon) `scoped_models_update`. See [Events over the daemon](#events-1) for the exact forwarded allowlist.

## Options Reference

These configure the in-process `createAgentSession()` and the helpers that feed it. The daemon resolves its own equivalents from the agent's `agent.json` and the shared credential store.

### Directories

Steward does not take `cwd`/`agentDir` options. On-disk locations are derived per agent from the home root (`~/.steward`, override `STEWARD_HOME`) by the `config.ts` getters:

```typescript
import { getAgentDir, getSessionsDir, getWorkspaceDir } from "@opsyhq/steward";

getAgentDir("my-agent");      // ~/.steward/agents/my-agent
getSessionsDir("my-agent");   // …/sessions       (JsonlSessionRepo root)
getWorkspaceDir("my-agent");  // …/workspace       (the stable cwd for the session)
```

Credentials and the default model live in the **shared** agent dir (`~/.steward/agent`, override `STEWARD_SHARED_DIR`) so one login works across every agent.

### Model

Resolve a `Model<Api>` through the `ModelRegistry`, then pass it to `createAgentSession()`:

```typescript
import { AuthStorage, ModelRegistry } from "@opsyhq/steward";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
```

The daemon resolves its model via `findInitialModel` with the precedence: `agent.json` override → shared default → known-provider defaults → first available. Over the daemon client, list and switch the live model with [`getAvailableModels()` / `setModel()`](#sessionhandle); thinking level is `set_thinking_level` (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`).

### API Keys and OAuth

Lead with **`/login`** for subscription/OAuth providers — over the daemon, login runs daemon-side (`login` command), so credentials never cross the wire and an OAuth flow prompts the client through the session UI rail. An **API key** (`ANTHROPIC_API_KEY`, etc.) is the alternative: it is read from the environment or `auth.json` as one credential source among several.

Auth precedence (handled by `AuthStorage`): runtime → `auth.json` (api key / OAuth) → env var. At request time, `createAgentSession()` routes through `modelRegistry.getApiKeyAndHeaders(model)` so custom `models.json` keys and per-provider headers apply.

```typescript
import { AuthStorage, ModelRegistry } from "@opsyhq/steward";

const authStorage = AuthStorage.create();   // shared ~/.steward/agent/auth.json
const modelRegistry = ModelRegistry.create(authStorage);
```

### System Prompt

Build the frozen prompt with `buildSystemPrompt()`, then pass the resulting string to `createAgentSession()`:

```typescript
import { buildSystemPrompt } from "@opsyhq/steward";

const systemPrompt = buildSystemPrompt({
  config,            // AgentConfig (name, purpose, deployedAt)
  soul,              // frozen SOUL.md snapshot ("" when absent)
  memory,            // frozen MEMORY.md snapshot
  user,              // frozen USER.md snapshot
  skills,            // Skill[] formatted into the prompt
  selectedTools,     // names of active tools, so guidance can tailor
  appendSystemPrompt // text appended to the end
});
```

The prompt is composed from the agent's identity (name + purpose), a frozen snapshot of curated memory (SOUL / MEMORY / USER), a deployed-vs-forming instruction block, and a docs-guidance block. It is **frozen for the session's lifetime** — edits to memory take effect next session.

### Tools

Pass an `AgentTool[]` to `createAgentSession({ tools })`. Steward ships built-in tool factories you compose yourself:

```typescript
import {
  createReadTool, createWriteTool, createEditTool,
  createBashTool, createGrepTool, createFindTool, createLsTool,
  createMemoryTool, createDeployTool,
} from "@opsyhq/steward";
```

> There is no `tools: ["read", "bash"]` string allowlist and no `noTools`/`excludeTools` here — you build the `AgentTool[]` explicitly and pass it. The daemon assembles the active set itself; over the client, read it with [`listTools()`](#sessionhandle).

### Extensions, Skills, Context Files, Slash Commands

`createAgentSession()` accepts `resources?: AgentHarnessResources` — skills and prompt templates pre-mapped into the harness shapes for explicit invocation (`harness.skill()` / `harness.promptFromTemplate()`). Full discovery (extensions, skills, prompt templates, integrations) is the `AgentRuntime`'s job, not a `createAgentSession()` option.

Helpers for assembling resources yourself:

```typescript
import { loadSkills, BUILTIN_SLASH_COMMANDS, discoverAndLoadExtensions } from "@opsyhq/steward";
```

Over the daemon client, inspect the resolved set with [`listSkills()` / `listContexts()` / `getCommands()` / `listTools()` / `listIntegrations()`](#sessionhandle). See [extensions.md](extensions.md), [skills.md](skills.md), and [integrations.md](integrations.md).

### Session Management

In-process, sessions come from [`openAgentSession()`](#openagentsession-and-agentruntime-internal-engine) (resume latest / by id / fresh) backed by a `JsonlSessionRepo` tree. Read a stored session tree with `SessionManager`. Over the daemon, the runtime owns session replacement — see [`Agent.createSession()`](#agent) and the `create_session` command. A **forming** (not-yet-deployed) agent refuses new sessions: it stays in its birth session until `deploy`.

### Settings Management

`AgentSettingsManager` reads and writes the agent's `agent.json` (`AgentConfig`: name, purpose, createdAt, port, token, the `deployedAt` deploy latch, and a `settings` override block — the default model lives in `settings.defaultModel`, read via `getDefaultModel()`) and the shared settings.

```typescript
import { AgentSettingsManager } from "@opsyhq/steward";

const store = AgentSettingsManager.create("my-agent");
store.getDefaultModel();
store.getAgentDeployed();
```

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  harness: AgentHarness;
}
```

That is the whole result — no extensions result, no model-fallback message. Everything else (events, model state, the session tree) is reached through the harness and the `session`/`repo` you passed in.

## Complete Example

In-process embedding: open a durable session, build the prompt, construct tools, drive the harness.

```typescript
import {
  openAgentSession,
  buildSystemPrompt,
  createAgentSession,
  createReadTool, createBashTool, createGrepTool,
  AuthStorage, ModelRegistry, AgentSettingsManager,
  findExactModelReferenceMatch, // model resolution helpers also exported
} from "@opsyhq/steward";

const name = "my-agent";

// Durable session + execution env (cwd is the agent's owned workspace).
const { session, env, cwd } = await openAgentSession(name, { fresh: true });

// Auth + model.
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const settingsManager = AgentSettingsManager.create(name);
const available = modelRegistry.getAvailable();
const model = available[0];
if (!model) throw new Error("No model with credentials. Log in with /login first.");

// Frozen system prompt.
const systemPrompt = buildSystemPrompt({
  config: settingsManager.config,
  selectedTools: ["read", "bash", "grep"],
});

// Tools, built for this cwd/env.
const tools = [
  createReadTool({ env, cwd }),
  createBashTool({ env, cwd }),
  createGrepTool({ env, cwd }),
];

const { harness } = await createAgentSession({
  env,
  session,
  model,
  systemPrompt,
  tools,
  modelRegistry,
  settingsManager,
  sessionId: session.id,
});

harness.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await harness.followUp("List the files here and summarize them.");
await harness.waitForIdle();
```

> Tool factory signatures vary; check the per-tool exports (`createReadTool`, `createBashTool`, …) in `src/core/tools/` for the exact options they take.

## Run Modes

Steward has one run mode that the SDK exposes: the **daemon**. There is no in-process interactive or print mode in this package (the interactive TUI lives in `@opsyhq/cli` and drives the agent over the daemon client).

### runDaemon

`runDaemon(name, opts?)` resolves the agent's model/auth, starts its `AgentRuntime`, binds the loopback HTTP/SSE server, and blocks until a signal — or a `shutdown` command — tears it down.

```typescript
import { runDaemon } from "@opsyhq/steward";

const exitCode = await runDaemon("my-agent", {
  port: undefined, // override the fixed per-agent port from agent.json (debugging)
});
```

It binds the agent's fixed host/port from `agent.json` (override host with `STEWARD_DAEMON_HOST`, port with `--port`). The `@opsyhq/cli` `daemon` subcommand and every OS service unit invoke this. See [RPC Mode](#rpc-mode) for the protocol it serves.

## Exports

The barrel (`src/index.ts`) re-exports the full surface. The load-bearing entries for each face:

```typescript
// ── In-process embedding ──
createAgentSession            // builds the AgentHarness
type CreateAgentSessionOptions, type CreateAgentSessionResult
openAgentSession              // durable session + env + repo
buildSystemPrompt             // the frozen system prompt
AuthStorage, ModelRegistry    // credentials + model resolution
AgentSettingsManager          // agent.json (AgentConfig)
SessionManager                // session tree
createReadTool, createWriteTool, createEditTool, createBashTool,
createGrepTool, createFindTool, createLsTool, createMemoryTool, createDeployTool

// ── Daemon engine (internal, but exported) ──
AgentRuntime, type AgentRuntimeOptions
runDaemon, type RunDaemonOptions

// ── Daemon client ──
Steward, Agent, SessionHandle

// ── Daemon protocol types ──
type DaemonCommand, type DaemonResponse, type DaemonControlEvent,
type DaemonAgentState, type DaemonSessionState, type DaemonSessionSummary,
type ExtensionUIRequest, type ExtensionUIResponse, type OnboardServiceResult
```

> There is no `loadAgentConfig` export — use `AgentSettingsManager`. `configureHttpDispatcher` is exported but tunes the **outbound LLM** undici dispatcher (idle timeout), not the control transport.

## RPC Mode

Steward's RPC equivalent is the per-agent daemon's loopback **HTTP/SSE control protocol**. A client attaches to a running daemon, drives sessions over JSON `POST` commands, and consumes session/agent events as Server-Sent Events.

> **Transport.** Not stdin/stdout JSONL, not `--mode rpc`. The wire is HTTP over a loopback socket (`http://127.0.0.1:<port>` by default), session-namespaced by URL path. Commands are a JSON body on `POST`; the synchronous response is that request's JSON body. Events stream as SSE, framed on the blank-line `\n\n` boundary. Every route except `/health` requires `Authorization: Bearer <token>`.

### Starting the daemon and its routes

Start it with [`runDaemon(name)`](#rundaemon), or let the client spawn one ([`Agent.connect()`](#agent)). It binds the agent's fixed host/port and serves these routes:

```
GET  /events                  (SSE) root control stream: agent snapshot + session lifecycle
GET  /sessions                       the session list (DaemonAgentState)
GET  /sessions/:id/events     (SSE) one session's curated event stream (attaching makes it live)
POST /sessions/:id/control           a command for that session; its sync response is the body
POST /sessions/:id/ui-response        a client's answer to that session's parked extension dialog
GET  /health                         liveness; the only route with no auth
```

The session id always comes from the **URL**, never the body. A session goes live when its first client attaches (rehydrating it if idle) and is evicted when its last client detaches (unless a turn is still in flight).

**Bearer auth.** All of `/events`, `/sessions`, and `/sessions/*` are guarded by Hono's `bearerAuth` against the agent's token. The token is the per-agent value in `agent.json`, overridable with `STEWARD_DAEMON_TOKEN`.

```
Authorization: Bearer <token>
```

`/health` answers `{ "status": "ok", "agent": "<name>", "pid": <pid>, "startedAt": "<iso>" }` with no auth, so a client can probe liveness before authenticating.

### Protocol Overview

**Envelope.** A command is `{ type, id?, …fields }`. The `id` is an optional correlation token echoed back on the response. The response is `{ id?, type: "response", command, success, data? | error }` — `data` is omitted entirely for async-ack commands (e.g. `prompt`).

```json
{ "id": "req-1", "type": "prompt", "message": "Hello" }
{ "id": "req-1", "type": "response", "command": "prompt", "success": true }
```

**SSE framing.** Each event is `event: <name>\n` + `data: <json>\n\n`. The session stream's first frame is `event: hello` carrying the session snapshot; later frames are `event: message`. A `: ping` comment line is sent every **15s** (`KEEPALIVE_MS`) so idle connections don't drop. Clients split the byte stream on `\n\n`, join multi-line `data:` fields, and skip comment (`:`) and malformed frames.

**Correlation id.** Set `id` on a command to match its response; events never carry an `id`.

**Replay ring.** Each session's broadcaster keeps the last **256** events (`RING_SIZE`) with a monotonic sequence id as the SSE `id:`. On reconnect, send `Last-Event-ID: <n>` and the daemon replays buffered frames with `id > n` (bounded by the watermark captured at attach, so live and replayed frames stay disjoint). Extension-UI request frames and control-stream lifecycle frames carry **no** `id` and are not replayable.

### Commands

`POST /sessions/:id/control` with a `DaemonCommand` body. The full set (from `src/types.ts`):

| Group | `type` | Notes |
|-------|--------|-------|
| Prompting | `prompt` | `{ message, images?, streamingBehavior? }`; acks on acceptance |
| | `steer` / `follow_up` | `{ message, images? }`; queue while streaming / after stop |
| | `abort` | abort the current turn |
| | `compact` | `{ customInstructions? }` |
| | `wait_for_idle` | resolves when the turn loop is idle |
| | `clear_queue` | returns the cleared `{ steering, followUp }` |
| Session | `create_session` | additive; returns the new session snapshot; a forming agent refuses |
| | `reload` | re-discover extensions/skills/prompts and rebuild the runner |
| | `deploy` | flip the deploy latch, install the OS unit, swap to a fresh deployed session |
| | `shutdown` | ack, then self-exit (frees the fixed port) |
| State | `get_state` | the session snapshot |
| | `get_messages` / `get_entries` | conversation messages / tree entries |
| | `get_commands` | slash commands (extension + prompt + skill) |
| | `get_resource_summary` | counts + diagnostics |
| | `get_tool_info` / `get_integration_info` / `get_skills` / `get_plugins` / `get_context_info` | capability reads |
| Mutation | `seed_assistant_message` / `append_message` | birth opener seed / resumed-message append |
| Plugins | `install_plugin` / `remove_plugin` / `update_plugins` | single-writer; the daemon reloads itself after |
| | `onboard_plugin` | runs the just-installed plugin's integration onboarding |
| Model | `set_thinking_level` | `{ level }` |
| | `set_model` | `{ provider, modelId }`; returns the resolved `Model` |
| | `get_available_models` | `{ models }` |
| | `set_scoped_models` / `set_enabled_models` | session-only scope / persisted agent-tier shortlist |
| Auth | `login` / `logout` | `{ provider, authType }`; runs daemon-side, credentials never cross the wire |
| | `get_login_providers` / `get_logout_providers` | eligible providers |

> This is steward's set, not pi's. There is no `cycle_model`, `cycle_thinking_level`, `set_steering_mode`/`set_follow_up_mode`, `bash`, `fork`/`clone`/`switch_session`, `export_html`, `get_session_stats`, or `set_session_name`. Steward adds `deploy`, `shutdown`, `reload`, `create_session`, `install_plugin`/`remove_plugin`/`update_plugins`/`onboard_plugin`, `login`/`logout`/`get_login_providers`/`get_logout_providers`, `get_available_models`, `set_scoped_models`/`set_enabled_models`, and the granular `get_*_info` reads.

Example — `set_model`:

```json
{ "type": "set_model", "provider": "anthropic", "modelId": "claude-opus-4-8" }
{ "type": "response", "command": "set_model", "success": true, "data": { /* Model */ } }
```

### Events

Each session streams a **curated subset** of the harness's event surface out of `GET /sessions/:id/events`. The broadcaster forwards only the allowlisted types (`FORWARDED_EVENT_TYPES` in `src/types.ts`); internal own-events (`save_point`, `settled`, `abort`, `session_*`, `tools_update`, `before_*`, …) stay inside the daemon.

| Forwarded event | Description |
|-----------------|-------------|
| `agent_start` / `agent_end` | agent begins / completes (`agent_end` carries the run's messages) |
| `turn_start` / `turn_end` | one assistant response + its tool calls (`turn_end.message`, `.toolResults`) |
| `message_start` / `message_update` / `message_end` | message lifecycle; `message_update.assistantMessageEvent` carries text/thinking/toolcall deltas |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | tool lifecycle; correlate by `toolCallId`, `tool_execution_end.isError` |
| `queue_update` | steering/follow-up queue changed (`.steer`, `.followUp`) |
| `model_update` | live model switched (`.model`) |
| `thinking_level_update` | thinking level changed (`.level`) |
| `scoped_models_update` | session model scope changed (`.scopedModels`) — host-originated, not a harness own-event |

> Steward forwards `model_update`, `thinking_level_update`, and `scoped_models_update` (none of which pi's RPC has) and drops `compaction_*`, `auto_retry_*`, and `extension_error`. `scoped_models_update` is bridged onto the session broadcaster by the runtime after `setScopedModels()` resolves.

**Control stream (`GET /events`).** A low-volume root stream whose `hello` frame is the agent snapshot (`DaemonAgentState`) and whose later frames are session-lifecycle events, so a client tracking the open-session list never has to poll:

```json
{ "type": "session_added",   "session": { /* DaemonSessionSummary */ } }
{ "type": "session_removed", "sessionId": "abc123" }
{ "type": "session_renamed", "sessionId": "abc123", "sessionName": "my-feature-work" }
```

### Extension UI Protocol

When a daemon-side extension calls `ctx.ui.select()`, `ctx.ui.confirm()`, etc., the daemon translates it into a request/response sub-protocol layered on the session stream.

- **Dialog methods** (`select`, `confirm`, `input`, `editor`) push an `extension_ui_request` frame, park a promise keyed by `id`, and block until the client answers with `POST /sessions/:id/ui-response`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`) push a request frame with no expected response.

Request frames are **not** `AgentHarnessEvent`s: they bypass the curated forwarded set and the replay ring (no SSE `id`, so a reconnect never re-delivers a stale dialog). All nine `method` literals are **camelCase** — `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`.

```json
{ "type": "extension_ui_request", "id": "uuid-1", "method": "select",
  "title": "Allow command?", "options": ["Allow", "Block"], "timeout": 10000 }
```

Answer (`POST /sessions/:id/ui-response`):

```json
{ "type": "extension_ui_response", "id": "uuid-1", "value": "Allow" }
{ "type": "extension_ui_response", "id": "uuid-2", "confirmed": true }
{ "type": "extension_ui_response", "id": "uuid-3", "cancelled": true }
```

A dialog with a `timeout` (ms) auto-resolves to its default when it expires. Surfaces that need real TUI access are degraded daemon-side: `custom()` returns `undefined`; `getEditorText()` returns `""`; `getToolsExpanded()` returns `false`; `setWorkingMessage`/`setWorkingIndicator`/`setFooter`/`setHeader`/`setEditorComponent` are no-ops; `pasteToEditor()` delegates to `setEditorText`; the theme family is inert. When the last client detaches, the session's parked dialogs resolve as cancelled (so a signal-less `editor` never hangs forever).

### Error Handling

A failed command returns the error arm:

```json
{ "type": "response", "command": "set_model", "success": false, "error": "Model not found: invalid/model" }
```

A malformed JSON body yields `{ "success": false, "error": "Malformed JSON body." }` (command `"unknown"`). An unresolvable session id (no such session) returns the error arm echoing the requested `command`/`id`. The typed client unwraps this: `Agent.send()` throws `new Error(body.error)` on `success: false`.

### Types

Source of truth: [`src/types.ts`](../src/types.ts) (`DaemonCommand`, `DaemonResponse`, `DaemonControlEvent`, `DaemonAgentState`, `DaemonSessionState`, `DaemonSessionSummary`, `ExtensionUIRequest`, `ExtensionUIResponse`, `OnboardServiceResult`, `FORWARDED_EVENT_TYPES`). Message/event/model types (`Model`, `AgentMessage`, `AgentEvent`) come from `@earendil-works/pi-ai` and `@opsyhq/agent`.

```typescript
interface DaemonSessionState {
  sessionId: string;
  model?: Model<Api>;
  thinkingLevel: ThinkingLevel;
  scopedModels: ScopedModel[];
  isStreaming: boolean;
  sessionName?: string;
  sessionFile?: string;
  messageCount: number;
  pendingMessageCount: number;
}
```

### Raw HTTP/SSE example

Driving the daemon with bare `fetch` (no typed client):

```typescript
const base = "http://127.0.0.1:7777";
const token = "<agent token from agent.json>";
const auth = { authorization: `Bearer ${token}` };

// 1. The session list.
const list = (await (await fetch(`${base}/sessions`, { headers: auth })).json()) as { sessions: { sessionId: string }[] };
const sessionId = list.sessions[0].sessionId;

// 2. Open the session's SSE stream and read frames split on "\n\n".
const events = await fetch(`${base}/sessions/${sessionId}/events`, { headers: auth });
void (async () => {
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;           // keepalive
        if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      }
      if (data) console.log(JSON.parse(data));
    }
  }
})();

// 3. Send a prompt.
await fetch(`${base}/sessions/${sessionId}/control`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ type: "prompt", message: "Hello" }),
});
```

### Typed client: Steward / Agent / SessionHandle

The typed client wraps all of the above. Three classes:

#### Steward

The agent collection on disk — holds no required state.

```typescript
import { Steward } from "@opsyhq/steward";

const steward = new Steward();
steward.list();                                  // Agent[] — every agent under the agents root
steward.get("my-agent");                         // Agent | undefined
steward.create("my-agent", { purpose, model }); // create the home tree, return the handle
```

#### Agent

One agent: registry data, per-agent lifecycle, and the `fetch`/SSE transport to its daemon (the single `send` site, the root control stream, the `SessionHandle` map).

```typescript
const agent = steward.get("my-agent")!;

await agent.connect();                  // find a live daemon (/health) or spawn a detached one, open the control stream
agent.getAgentState();                  // DaemonAgentState (config, cwd, sessions) from the control hello
await agent.listSessions();             // DaemonSessionSummary[] — round-trips GET /sessions
await agent.getSession(id);             // open (or return cached) SessionHandle, with its event stream
await agent.getLatestSession();         // the most-recent session (the daemon guarantees one exists)

await agent.createSession();            // additive: a fresh session snapshot (caller switches to it)
await agent.deploy();                   // commit the deploy + drive the stop-then-start daemon handoff
await agent.restart();                  // bounce the daemon so it picks up code changes
await agent.delete();                   // uninstall the OS unit, stop the daemon, delete the home dir

const off = agent.on("sessionAdded", (s) => { /* … */ });  // control-stream lifecycle listeners
agent.close();                          // close every session stream + the control stream
```

> `connect()` opens **no** session — call `getSession(id)` / `getLatestSession()` afterward. `createSession`/`deploy` are agent-level (they spawn a session and may swap the transport), so they live on `Agent`, not `SessionHandle`.

#### SessionHandle

The per-session proxy. Verbs round-trip through `agent.send(sessionId, …)`; the session's SSE feeds the local snapshot/queue caches.

> **Ordering.** Opening a handle (`getSession`/`getLatestSession`) attaches the SSE stream — which is also what makes the session **live** on the daemon (rehydrating it if idle). Call `subscribe(...)` (and set `onUiRequest`) **before** `prompt(...)`, or you miss the leading deltas and any extension dialog that turn raises. `prompt()` resolves on acceptance; await `waitForIdle()` for completion. When the last handle closes, the daemon evicts the session (unless a turn is still streaming) — so keep the handle open for the whole turn, and remember a closed handle's parked dialogs resolve as cancelled.

```typescript
const session = await agent.getLatestSession();

// Prompting (steer/follow-up via streamingBehavior — no separate steer()/followUp()).
await session.prompt("Do this", { images, streamingBehavior: "steer" });
await session.abort();
await session.compact(customInstructions);
await session.waitForIdle();
await session.clearQueue();

// Subscribe to the curated session events.
const unsubscribe = session.subscribe((event) => { /* AgentHarnessEvent */ });
session.onUiRequest = (req) => { /* extension-UI dialog frame */ };
await session.respondUi(req.id, { value: "Allow" });

// Reads (cached snapshot vs round-trip).
session.getModel(); session.getThinkingLevel(); session.getScopedModels();
session.getSessionName(); session.getResourceSummary(); session.getCommands();
session.getSteeringMessages(); session.getFollowUpMessages();
await session.getEntries(); await session.buildSessionContext();
await session.listTools(); await session.listSkills(); await session.listPlugins();
await session.listIntegrations(); await session.listContexts();

// Model / thinking / scope.
await session.getAvailableModels();
await session.setModel("anthropic", "claude-opus-4-8");
await session.setThinkingLevel("high");
await session.setScopedModels(ids); await session.setEnabledModels(ids);

// Auth (daemon-side; OAuth prompts round-trip via respondUi).
await session.getLoginProviderOptions("oauth");
await session.login("anthropic", "oauth");
await session.logout("anthropic");

// Plugins (single-writer; the daemon reloads itself after).
await session.installPlugin(source);
await session.removePlugin(source);
await session.updatePlugins(source);
await session.onboardPlugin(source);

session.close();
```

> The client's extension surface is **inert** — the runner lives server-side: `getShortcuts()` returns an empty map, `getMessageRenderer()` returns `undefined`, `emitUserBash()` resolves `undefined`, and `createShortcutContext()` throws. The only live extension bridge is `onUiRequest` + `respondUi`.

## Integrations

Integrations (per-agent service connections with their own onboarding and producer loops) are configured and onboarded over the daemon (`onboard_plugin`, `login`) and inspected with `SessionHandle.listIntegrations()`. The integration authoring API (`createIntegrationRuntime`, `Integration`, `IntegrationAction`, onboarding context) is re-exported from the barrel. See [integrations.md](integrations.md) for the full surface.

## Configuration and Environment

Daemon and agent-home environment variables (from `config.ts`):

| Variable | Purpose | Default |
|----------|---------|---------|
| `STEWARD_HOME` | Root config dir holding all agents | `~/.steward` |
| `STEWARD_SHARED_DIR` | Shared credential dir (`auth.json`, `settings.json`) | `~/.steward/agent` |
| `STEWARD_DAEMON_HOST` | Host the daemon binds | `127.0.0.1` (set `0.0.0.0` for off-box) |
| `STEWARD_DAEMON_TOKEN` | Bearer token override (else the per-agent `agent.json` token) | unset |
| `STEWARD_SERVICE_MANAGER` | Force the OS service backend (`none`/`launchd`/`systemd`) | autodetect |
| `STEWARD_SANDBOX` | File/shell confinement backend (`host`/`local-os`/`docker`/`auto`) | `auto` |
| `STEWARD_BYPASS_PERMISSIONS` | Auto-approve every host command (`1`/`true`) | unset |
| `ANTHROPIC_API_KEY` (and peers) | API-key credential source (the **alternative** to `/login`) | unset |

Per-agent on-disk layout (`~/.steward/agents/<name>/`):

```
agents/<name>/
  agent.json        AgentConfig: name, purpose, port, token, deployedAt latch, settings (incl. defaultModel)
  SOUL.md           who the agent is / what it's for (authored at deploy)
  MEMORY.md         durable notes (edited via the memory tool)
  USER.md           facts about the human
  sessions/         JsonlSessionRepo session tree
  workspace/        the stable cwd passed to every session
  integrations.json per-(service, account) credential registry
  store/            per-integration runtime state, one file per service
  approvals.json    durable host-escalation prefix rules
```
