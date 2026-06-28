# Extensions

Extensions are TypeScript modules that extend Wolli's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more.

> **Placement for /reload:** Put extensions in an agent's `~/.wolli/agents/<name>/extensions/` for auto-discovery, or list extra paths under `extensions` in `settings.json`. Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

**Key capabilities:**
- **Custom tools** - Register tools the LLM can call via `wolli.registerTool()`
- **Event interception** - Block or modify tool calls, inject context, customize compaction
- **User interaction** - Prompt users via `ctx.ui` (select, confirm, input, notify)
- **Custom UI components** - Full TUI components with keyboard input via `ctx.ui.custom()` for complex interactions
- **Custom commands** - Register commands like `/mycommand` via `wolli.registerCommand()`
- **Session persistence** - Store state that survives restarts via `ctx.session.appendEntry()`
- **Custom rendering** - Control how tool calls/results and messages appear in TUI

**Example use cases:**
- Permission gates (confirm before `rm -rf`, `sudo`, etc.)
- Git checkpointing (stash at each turn, restore on branch)
- Path protection (block writes to `.env`, `node_modules/`)
- Custom compaction (summarize conversation your way)
- Interactive tools (questions, wizards, custom dialogs)
- Stateful tools (todo lists, connection pools)
- External integrations (file watchers, webhooks, CI triggers)

> **Note:** The extension factory's first argument is named `wolli` throughout this document. That name is just a convention for the extension API object — call it whatever you like. (The package.json manifest key used to declare extensions is `"wolli"`; that key name is fixed and unrelated to the argument name.)
>
> Every event handler, command, shortcut, and custom-tool `execute` receives a context bag as its last argument: `ctx: ExtensionContext`, where `ExtensionContext = { session, ui, mode }`. Examples destructure it as `{ session, ui, mode }`. `session` is the live session this invocation acts on (carrying `sessionManager`, `model`, `sendMessage`, `compact`, etc.); `ui` is that session's presentation channel; `mode` is the current run mode. Agent-global capabilities (cwd, environments, model registry, session discovery, integrations, reload, shutdown) live on `wolli`.

## Table of Contents

- [Quick Start](#quick-start)
- [Extension Locations](#extension-locations)
- [Available Imports](#available-imports)
- [Writing an Extension](#writing-an-extension)
  - [Extension Styles](#extension-styles)
- [Events](#events)
  - [Lifecycle Overview](#lifecycle-overview)
  - [Handler Ordering and Folding](#handler-ordering-and-folding)
  - [Session Events](#session-events)
  - [Agent Events](#agent-events)
  - [Model Events](#model-events)
  - [Tool Events](#tool-events)
  - [User Bash Events](#user-bash-events)
  - [Input Events](#input-events)
- [ExtensionContext](#extensioncontext)
  - [ctx.session members](#ctxsession-members)
  - [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns)
- [ExtensionAPI Methods](#extensionapi-methods)
- [State Management](#state-management)
- [Custom Tools](#custom-tools)
- [Custom UI](#custom-ui)
- [Error Handling](#error-handling)
- [Mode Behavior](#mode-behavior)
- [Worked Examples](#worked-examples)

## Quick Start

Create `~/.wolli/agents/<name>/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";
import { Type } from "typebox";

export default function (wolli: ExtensionAPI) {
  // React to events
  wolli.on("session_start", async (_event, { ui }) => {
    ui.notify("Extension loaded!", "info");
  });

  wolli.on("tool_call", async (event, { ui }) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  wolli.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  wolli.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, { ui }) => {
      const name = args.trim() || "world";
      ui.notify(`Hello ${name}!`, "info");
    },
  });
}
```

The agent loads extensions from its `extensions/` directory automatically. After editing one, run `/reload` to pick up the change without restarting.

## Extension Locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Extensions are auto-discovered from the agent's own home, because each agent owns its extensions. There is no project-local extension location.

| Location | Scope |
|----------|-------|
| `~/.wolli/agents/<name>/extensions/*.ts` | The agent (all sessions) |
| `~/.wolli/agents/<name>/extensions/*/index.ts` | The agent (subdirectory) |

Additional paths via `settings.json` (`extensions` is `string[]`):

```json
{
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

## Available Imports

| Package | Purpose |
|---------|---------|
| `@opsyhq/wolli` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@earendil-works/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@opsyhq/tui` | TUI components for custom rendering |

npm dependencies work too. Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically.

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.

## Writing an Extension

An extension exports a default factory function that receives `ExtensionAPI`. The factory can be synchronous or asynchronous:

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

export default function (wolli: ExtensionAPI) {
  // Subscribe to events
  wolli.on("event_name", async (event, { ui }) => {
    // ui for user interaction
    const ok = await ui.confirm("Title", "Are you sure?");
    ui.notify("Done!", "info");
    ui.setStatus("my-ext", "Processing...");  // Footer status
    ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  wolli.registerTool({ ... });
  wolli.registerCommand("name", { ... });
  wolli.registerShortcut("ctrl+x", { ... });
  wolli.registerFlag("my-flag", { ... });
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

If the factory returns a `Promise`, Wolli awaits it before continuing startup. That means async initialization completes before `session_start`.

### Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration.

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

export default async function (wolli: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/config");
  const config = await response.json();
  // Use config to set up tools, commands, etc.
}
```

### Extension Styles

**Single file** - simplest, for small extensions:

```
~/.wolli/agents/<name>/extensions/
└── my-extension.ts
```

**Directory with index.ts** - for multi-file extensions:

```
~/.wolli/agents/<name>/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies** - for extensions that need npm packages:

```
~/.wolli/agents/<name>/extensions/
└── my-extension/
    ├── package.json    # Declares dependencies and entry points
    ├── package-lock.json
    ├── node_modules/   # After npm install
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "wolli": {
    "extensions": ["./src/index.ts"]
  }
}
```

Run `npm install` in the extension directory, then imports from `node_modules/` work automatically.

## Events

### Lifecycle Overview

```
Wolli starts
  │
  └─► session_start { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_request (can inspect or replace payload)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /sessions (switch session)
  ├─► session_shutdown
  └─► session_start { reason: "new" | "resume", previousSessionFile? }

/compact or auto-compaction
  └─► session_before_compact (can cancel or customize)

/model or Ctrl+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, ctx.session.setThinkingLevel())
  └─► thinking_level_select

exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### Handler Ordering and Folding

The diagram above is the order *events* fire. Within a single event, multiple handlers can be registered — across extensions, and within one extension. Wolli always invokes them in the same nesting:

```
for each extension (in extension load order)
  for each handler that extension registered for this event (in registration order)
    await handler(event, ctx)
```

So "extension load order" decides which extension's handlers run first, and registration order (the order you called `wolli.on(...)` inside that extension's factory) decides ordering among handlers from the same extension.

How return values combine depends on the event. There are four shapes:

| Event | How handlers combine |
|-------|----------------------|
| `tool_call` | Each `{ block, reason }` is recorded; the **first** handler to return `{ block: true }` short-circuits and the tool never runs. Argument mutations (`event.input` mutated in place) are cumulative — later handlers see earlier mutations. |
| `input`, `user_bash` | First-wins short-circuit. For `input`, `{ action: "handled" }` stops the chain immediately; `{ action: "transform" }` rewrites `event.text`/`event.images` and continues so later handlers see the rewritten text. For `user_bash`, the first handler returning any result wins and the rest are skipped. |
| `context`, `before_provider_request`, `before_agent_start`, `tool_result`, `message_end` | Fold/chain: the running value (messages, payload, system prompt, result fields, finalized message) threads through every handler, and each handler sees the previous handler's output. `message_end` rejects (and logs) any replacement whose `role` differs from the original. `before_agent_start` accumulates injected `message`s from all handlers while chaining `systemPrompt`. |
| everything else (`session_*`, `agent_*`, `turn_*`, `message_start`/`message_update`, `tool_execution_*`, `model_select`, `thinking_level_select`) | Notification-only. Return values are ignored; all handlers run. |

> A throw inside one handler is caught, reported through the extension error channel, and does **not** stop the remaining handlers. Never rely on a sibling handler's failure to halt processing — for fail-safe gating, return an explicit `{ block: true }` from `tool_call`.

You cannot control cross-extension ordering from inside an extension; it follows the order extensions are discovered/loaded. Within your own extension, order your `wolli.on(...)` calls if one handler must observe another's mutation first.

### Session Events

#### session_start

Fired when a session is started, loaded, or reloaded.

```typescript
wolli.on("session_start", async (event, { session, ui }) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - present for "new", "resume", and "fork"
  ui.notify(`Session: ${session.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

After a successful switch or new-session action, Wolli emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "new" | "resume"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_compact

Fired on compaction. **Can cancel or customize.**

```typescript
wolli.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

#### session_shutdown

Fired before an extension runtime is torn down.

```typescript
wolli.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
  // Cleanup, save state, etc.
});
```

### Agent Events

#### before_agent_start

Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt.

```typescript
wolli.on("before_agent_start", async (event, ctx) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .config - the agent config (present at the real call site)
  //   .cwd - working directory
  //   .soul - frozen SOUL.md snapshot ("" when absent)
  //   .memory - frozen MEMORY.md snapshot ("" when absent)
  //   .user - frozen USER.md snapshot ("" when absent)
  //   .skills - skills discovered for this agent
  //   .selectedTools - names of the tools active this session
  //   .appendSystemPrompt - text appended to the end of the system prompt

  return {
    // Inject a persistent message (stored in session, sent to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Replace the system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

The `systemPromptOptions` field gives extensions access to the same structured data Wolli uses to build the system prompt (type `BuildSystemPromptOptions`). This lets you inspect what Wolli has loaded — the agent config, frozen SOUL/MEMORY/USER snapshots, discovered skills, the active tool names, and any appended system-prompt text — without re-discovering resources or re-parsing flags. Use it when your extension needs to make deep, informed changes to the system prompt while respecting user-provided configuration.

Inside `before_agent_start`, `event.systemPrompt` and `ctx.session.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again.

#### agent_start / agent_end

Fired once per user prompt.

```typescript
wolli.on("agent_start", async (_event, ctx) => {});

wolli.on("agent_end", async (event, ctx) => {
  // event.messages - messages from this prompt
});
```

#### turn_start / turn_end

Fired for each turn (one LLM response + tool calls).

```typescript
wolli.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

wolli.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

Fired for message lifecycle updates.

- `message_start` and `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming updates.
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`.

```typescript
wolli.on("message_start", async (event, ctx) => {
  // event.message
});

wolli.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent (token-by-token stream event)
});

wolli.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

Fired for tool execution lifecycle updates.

In parallel tool mode:
- `tool_execution_start` is emitted in assistant source order during the preflight phase
- `tool_execution_update` events may interleave across tools
- `tool_execution_end` is emitted in tool completion order after each tool is finalized
- final `toolResult` message events are still emitted later in assistant source order

```typescript
wolli.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

wolli.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

wolli.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

Fired before each LLM call. Modify messages non-destructively.

```typescript
wolli.on("context", async (event, ctx) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_request

Fired after the provider-specific payload is built, right before the request is sent. Handlers run in extension load order. Returning `undefined` keeps the payload unchanged. Returning any other value replaces the payload for later handlers and for the actual request.

This hook can rewrite provider-level system instructions or remove them entirely. Those payload-level changes are not reflected by `ctx.session.getSystemPrompt()`, which reports Wolli's system prompt string rather than the final serialized provider payload.

```typescript
wolli.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

This is mainly useful for debugging provider serialization and cache behavior.

> **`console.log` and the TUI.** `console.log`/`console.error` write to the host's stdout/stderr. In `mode === "tui"` that shares the terminal with the rendered UI and can corrupt it. There is no logger on `ExtensionContext`. For user-visible diagnostics in interactive mode, use `ui.notify(...)` or `ui.setStatus(...)` instead. Raw `console.*` output is safe in the non-TUI modes (`rpc`, `json`, `print`), so guard it with `ctx.mode !== "tui"` if you need it in both.

### Model Events

#### model_select

Fired when the model changes via `/model` command, model cycling (`Ctrl+P`), or session restore.

```typescript
wolli.on("model_select", async (event, { ui }) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

Use this to update UI elements (status bars, footers) or perform model-specific initialization when the active model changes.

#### thinking_level_select

Fired when the thinking level changes. This is notification-only; handler return values are ignored.

```typescript
wolli.on("thinking_level_select", async (event, { ui }) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Use this to update extension UI when `ctx.session.setThinkingLevel()`, model changes, or built-in thinking-level controls change the active thinking level.

### Tool Events

#### tool_call

Fired after `tool_execution_start`, before the tool executes. **Can block.** Use `isToolCallEventType` to narrow and get typed inputs.

Before `tool_call` runs, Wolli waits for previously emitted Agent events to finish draining. This means `ctx.session.sessionManager` is up to date through the current assistant tool-calling message.

In the default parallel tool execution mode, sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results from that same assistant message in `ctx.session.sessionManager`.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution.

Behavior guarantees:
- Mutations to `event.input` affect the actual tool execution
- Later `tool_call` handlers see mutations made by earlier handlers
- No re-validation is performed after your mutation
- Return values from `tool_call` only control blocking via `{ block: true, reason?: string }`

```typescript
import { isToolCallEventType } from "@opsyhq/wolli";

wolli.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit", etc.
  // event.toolCallId
  // event.input - tool parameters (mutable)

  // Built-in tools: no type params needed
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command" };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### Typing custom tool input

Custom tools should export their input type:

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

Use `isToolCallEventType` with explicit type parameters:

```typescript
import { isToolCallEventType } from "@opsyhq/wolli";
import type { MyToolInput } from "my-extension";

wolli.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // typed
  }
});
```

#### tool_result

Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. **Can modify result.**

In parallel tool mode, `tool_result` and `tool_execution_end` may interleave in tool completion order, while final `toolResult` message events are still emitted later in assistant source order.

`tool_result` handlers chain like middleware:
- Handlers run in extension load order
- Each handler sees the latest result after previous handler changes
- Handlers can return partial patches (`content`, `details`, or `isError`); omitted fields keep their current values

Use `ctx.session.signal` for nested async work inside the handler. This lets Esc cancel model calls, `fetch()`, and other abort-aware operations started by the extension.

```typescript
import { isBashToolResult } from "@opsyhq/wolli";

wolli.on("tool_result", async (event, { session }) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: session.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false };
});
```

### User Bash Events

#### user_bash

Fired when user executes `!` or `!!` commands. **Can intercept.**

```typescript
import { createHostEnvironment } from "@opsyhq/wolli";

wolli.on("user_bash", (event, ctx) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Run the command in a custom environment (e.g., a sandbox)
  return { environment: customEnvironment };

  // Option 2: Wrap Wolli's host environment to rewrite commands
  const host = createHostEnvironment(event.cwd);
  return {
    environment: {
      ...host,
      exec: (command, cwd, options) => host.exec(`source ~/.profile\n${command}`, cwd, options),
    },
  };

  // Option 3: Full replacement - return result directly
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### Input Events

#### input

Fired when user input is received, after extension commands are checked but before skill and template expansion. The event sees the raw input text, so `/skill:foo` and `/template` are not yet expanded.

**Processing order:**
1. Extension commands (`/cmd`) checked first - if found, handler runs and input event is skipped
2. `input` event fires - can intercept, transform, or handle
3. If not handled: skill commands (`/skill:name`) expanded to skill content
4. If not handled: prompt templates (`/template`) expanded to template content
5. Agent processing begins (`before_agent_start`, etc.)

```typescript
wolli.on("input", async (event, { ui }) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed), "rpc", or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   undefined when idle, "steer" for mid-stream interrupts,
  //   "followUp" for messages queued until the agent finishes

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Route by source: skip processing for extension-injected messages
  if (event.source === "extension") return { action: "continue" };

  // Intercept skill commands before expansion
  if (event.text.startsWith("/skill:")) {
    // Could transform, block, or let pass through
  }

  return { action: "continue" };  // Default: pass through to expansion
});
```

**Results:**
- `continue` - pass through unchanged (default if handler returns nothing)
- `transform` - modify text/images, then continue to expansion
- `handled` - skip agent entirely (first handler to return this wins)

Transforms chain across handlers.

## ExtensionContext

Every event handler, command, shortcut, and custom-tool `execute` receives a context bag as its last argument: `ctx: ExtensionContext`. It has exactly three members:

```typescript
interface ExtensionContext {
  session: Session;          // the live session this handler/tool/command acts on
  ui: ExtensionUIContext;    // that session's presentation channel
  mode: ExtensionMode;       // "tui" | "rpc" | "json" | "print"
}
```

Destructure whichever you need, e.g. `{ session }`, `{ ui }`, or `{ session, ui, mode }`.

- **`ctx.session`** is the live session the handler is acting on. It carries the per-session surface (session manager, model, abort signal, send/append/compact actions, tool and model controls). See [ctx.session members](#ctxsession-members).
- **`ctx.ui`** is the UI rail for user interaction, scoped to this session: a dialog raised through `ui` routes only to this session's subscribers. See [Custom UI](#custom-ui) for the full surface.
- **`ctx.mode`** is the current run mode: `"tui"`, `"rpc"`, `"json"`, or `"print"`. Use `ctx.mode === "tui"` to guard terminal-only features such as `custom()`, component factories, terminal input, and direct TUI rendering. See [Mode Behavior](#mode-behavior).

Outside a handler (for example, in an integration `.on(...)` callback registered at load time), there is no `ctx` in scope. Reach a session through the agent-global discovery methods on `wolli` — `wolli.getSession(id)`, `wolli.openSession(id)`, `wolli.createSession()` — described in [ExtensionAPI Methods](#extensionapi-methods).

### ctx.session members

The members below all live on `ctx.session` (type `Session`).

#### session.sessionManager

Read-only access to session state.

For `tool_call`, this state is synchronized through the current assistant message before handlers run. In parallel tool execution mode it is still not guaranteed to include sibling tool results from the same assistant message.

```typescript
session.sessionManager.getEntries()       // All entries
session.sessionManager.getBranch()        // Current branch
session.sessionManager.getLeafId()        // Current leaf entry ID
session.sessionManager.getLabel(entryId)  // Label on an entry, if any
session.sessionManager.getSessionFile()   // Session file path, or undefined
```

To write tags onto a session, use `appendTags(tags: Record<string, string>): Promise<string>` — the method to call on the `SessionManager` handed to a `createSession({ setup })` callback. (`session.getTags()` / `session.setTags(tags)` read and replace the live session's folded tags; `appendTags` is the additive form used when seeding a freshly created session.)

#### session.model

The current model, or `undefined`. For the model registry and API keys, use `wolli.modelRegistry` (see [ExtensionAPI Methods](#extensionapi-methods)).

#### session.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:
- `fetch(..., { signal: session.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`session.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events, extension commands, and shortcuts fired while Wolli is idle.

```typescript
wolli.on("tool_result", async (event, { session }) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: session.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

#### session.prompt(text, options?)

Submit user input through the full command/skill/prompt pipeline, then hand off to the harness.

#### session.isIdle() / session.abort() / session.waitForIdle() / session.getPendingMessageCount() / session.hasPendingMessages()

Control flow helpers.

`session.waitForIdle()` waits for the agent to finish streaming:

```typescript
wolli.registerCommand("my-cmd", {
  handler: async (args, { session }) => {
    await session.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

#### session.getContextUsage()

Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages. The `tokens` and `percent` fields are `null` when token count is unknown (e.g. right after compaction, before the next LLM response).

```typescript
const usage = session.getContextUsage();
if (usage && usage.tokens !== null && usage.tokens > 100_000) {
  // ...
}
```

#### session.compact(options?)

Trigger compaction without awaiting completion. Use `onComplete` and `onError` for follow-up actions.

```typescript
session.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

#### session.getSystemPrompt()

Returns Wolli's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
wolli.on("before_agent_start", (event, { session }) => {
  const prompt = session.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

#### session.getSystemPromptOptions()

Returns the base inputs Wolli currently uses to build the system prompt.

```typescript
const options = session.getSystemPromptOptions();
const activeToolNames = options.selectedTools ?? [];
```

This has the same shape as `before_agent_start` `event.systemPromptOptions` (type `BuildSystemPromptOptions`): the agent config, cwd, frozen SOUL/MEMORY/USER snapshots, discovered skills, the active tool names (`selectedTools`), and appended system-prompt text. The frozen memory snapshots can contain sensitive content, so treat it as sensitive extension-local data and avoid exposing it through command lists, logs, or autocomplete metadata.

This reports the current base prompt inputs. It does not include per-turn `before_agent_start` chained system-prompt changes, later `context` event message mutations, or `before_provider_request` payload rewrites.

#### session.sendMessage(message, options?)

Inject a custom message into the session. Signature:

```typescript
sendMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): void;
```

`CustomMessage<T>` fields you pass: `customType: string`, `content: string | (TextContent | ImageContent)[]`, `display: boolean` (show in TUI), and optional `details?: T` (arbitrary payload available to a registered renderer and to state reconstruction).

```typescript
session.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

> **`sendMessage` vs `appendEntry`.** `sendMessage` creates a `role: "custom"` message entry that **is** shown in the TUI (when `display: true`) and **is** sent to the LLM — `convertToLlm` maps a `custom` message to a `user` message, so its `content` enters model context. `appendEntry` (see [session.appendEntry](#sessionappendentrycustomtype-data)) stores a role-less custom entry that is **not** part of LLM context at all. Use `sendMessage` to put something in front of both the user and the model; use `appendEntry` for invisible extension-only state. The two also persist as different entry kinds — see [State Management](#state-management).

**Options:**
- `deliverAs` - Delivery mode:
  - `"steer"` (default) - Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
  - `"followUp"` - Waits for agent to finish. Delivered only when agent has no more tool calls.
  - `"nextTurn"` - Queued for next user prompt. Does not interrupt or trigger anything.
- `triggerTurn: true` - If agent is idle, trigger an LLM response immediately. Only applies to `"steer"` and `"followUp"` modes (ignored for `"nextTurn"`).

When the agent is idle and `triggerTurn` is omitted/false, the message is appended (and persisted) without starting an LLM turn.

#### session.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()` which sends custom messages, this sends an actual user message that appears as if typed by the user. Always triggers a turn.

```typescript
// Simple text message
session.sendUserMessage("What is 2+2?");

// With content array (text + images)
session.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
session.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
session.sendUserMessage("And then summarize", { deliverAs: "followUp" });
```

**Options:**
- `deliverAs` - Required when agent is streaming:
  - `"steer"` - Queues the message for delivery after the current assistant turn finishes executing its tool calls
  - `"followUp"` - Waits for agent to finish all tools

When not streaming, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, throws an error.

#### session.appendEntry(customType, data?)

Persist extension state (does NOT participate in LLM context).

```typescript
wolli.on("session_start", async (_event, { session }) => {
  session.appendEntry("my-state", { count: 42 });

  // Restore on reload
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

#### session.getSessionName() / session.setSessionName(name)

Get or set the session display name (shown in the session selector instead of the first message).

```typescript
session.setSessionName("Refactor auth module");

const name = session.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

#### session.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation.

```typescript
// Set a label
session.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
session.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = session.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

#### session.getTags() / session.setTags(tags)

Read or merge the session's folded tags — a durable, append-only key/value binding an extension owns (for example, to an external chat). Core never interprets the keys. Query across sessions with `wolli.findSessions(...)`.

```typescript
session.setTags({ "telegram:chat": String(chatId) });

const tags = session.getTags();
const chat = tags["telegram:chat"];
```

#### session.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list order is: extensions first, then templates, then skills.

```typescript
const commands = session.getCommands();
const fromExtensions = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

Each entry has this shape (`SlashCommandInfo`):

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: SourceInfo;  // { path, source, scope, origin, baseDir? }
}
```

Use `sourceInfo` as the canonical provenance field. Do not infer ownership from command names or from ad hoc path parsing.

Built-in interactive commands (like `/model` and `/settings`) are not included here. They are handled only in interactive mode and would not execute if sent via `prompt`.

#### session.getActiveTools() / session.getAllTools() / session.setActiveTools(names) / session.refreshTools()

Manage active tools. This works for both built-in tools and dynamically registered tools.

```typescript
const active = session.getActiveTools();
const all = session.getAllTools();
// [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const names = all.map(t => t.name);
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
session.setActiveTools(["read", "bash"]); // Switch to read-only
```

`session.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.

`session.refreshTools()` re-applies the base + extension tool set, picking up tools registered mid-session.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ tools })`
- extension source metadata for tools registered by extensions

#### session.setModel(model) / session.setModelById(provider, modelId)

Set the current model. `setModel` returns `false` if no API key is available for the model. `setModelById` resolves `{ provider, modelId }` and throws if the model is unknown or unauthenticated.

```typescript
const model = wolli.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await session.setModel(model);
  if (!success) {
    ui.notify("No API key for this model", "error");
  }
}
```

#### session.getThinkingLevel() / session.setThinkingLevel(level)

Get or set the thinking level. Level is clamped to model capabilities (non-reasoning models always use "off"). Changes emit `thinking_level_select`.

```typescript
const current = session.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
await session.setThinkingLevel("high");
```

#### session.newSession(options?)

Start a new session, optionally with initialization. The new session goes live; other resident sessions stay live (additive).

```typescript
const kickoff = "Continue in the replacement session";

const result = await session.newSession({
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (newSession) => {
    // Use only the replacement session here.
    await newSession.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

Options:
- `setup`: mutate the new session's `SessionManager` before `withSession` runs
- `withSession`: run post-switch work against the fresh replacement `Session`. Do not use a captured old `session`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

#### session.reload()

Run the same reload flow as `/reload`.

```typescript
wolli.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, and themes",
  handler: async (_args, { session }) => {
    await session.reload();
    return;
  },
});
```

Important behavior:
- `await session.reload()` emits `session_shutdown` for the current extension runtime
- It then reloads resources and emits `session_start` with `reason: "reload"`
- The currently running command handler still continues in the old call frame
- Code after `await session.reload()` still runs from the pre-reload version
- Code after `await session.reload()` must not assume old in-memory extension state is still valid
- After the handler returns, future commands/events/tool calls use the new extension version

For predictable behavior, treat reload as terminal for that handler (`await session.reload(); return;`).

`wolli.reload()` runs the same flow at the agent-global level.

Example tool the LLM can call to trigger reload (tools queue a follow-up command rather than reloading inline):

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";
import { Type } from "typebox";

export default function (wolli: ExtensionAPI) {
  wolli.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, { session }) => {
      await session.reload();
      return;
    },
  });

  wolli.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, { session }) {
      session.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
        details: {},
      };
    },
  });
}
```

### Session replacement lifecycle and footguns

`withSession` receives the fresh replacement `Session`.

Lifecycle and footguns:
- `withSession` runs only after the old session has emitted `session_shutdown`, the old runtime has been torn down, the replacement session has been rebound, and the new extension instance has already received `session_start`.
- The callback still executes in the original closure, not inside the new extension instance. That means your old extension instance may already have run its shutdown cleanup before `withSession` starts.
- A captured old `session` is stale after replacement and will throw if used. Use only the `session` passed to `withSession` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = session.sessionManager` before replacement, `sm` is still the old `SessionManager` object. Do not reuse it after replacement.
- Code in `withSession` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.

Safe pattern:

```typescript
wolli.registerCommand("handoff", {
  handler: async (_args, { session }) => {
    const kickoff = "Continue from the replacement session";
    await session.newSession({
      withSession: async (newSession) => {
        await newSession.sendUserMessage(kickoff);
      },
    });
  },
});
```

Unsafe pattern:

```typescript
wolli.registerCommand("handoff", {
  handler: async (_args, { session }) => {
    const oldSessionManager = session.sessionManager;
    await session.newSession({
      withSession: async (_newSession) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        session.sendUserMessage("wrong");
      },
    });
  },
});
```

## ExtensionAPI Methods

Methods are split across two objects. The agent-global ones live on `wolli` (the extension factory argument): registration, provider management, integrations, the shared event bus, and session discovery/creation.

Per-session actions (`sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `setActiveTools`, `setModel`, `setThinkingLevel`, etc.) live on `ctx.session` instead — destructure `{ session }` from a handler's context, or reach a session through `wolli.getSession(id)` / `wolli.openSession(id)` outside a handler. The `ctx.session` members are documented in [ctx.session members](#ctxsession-members); the `wolli.*` methods are documented here.

### wolli.on(event, handler)

Subscribe to events. See [Events](#events) for event types and return values.

### wolli.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom Tools](#custom-tools) for full details.

`wolli.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `ctx.session.getAllTools()` and are callable by the LLM without `/reload`.

Use `ctx.session.setActiveTools()` to enable or disable tools (including dynamically added tools) at runtime.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active.

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

wolli.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional compatibility shim. Runs before schema validation.
    // Return the current schema shape, for example to fold legacy fields
    // into the modern parameter object.
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### wolli.registerCommand(name, options)

Register a command.

The handler signature is `(args: string, ctx: ExtensionContext) => Promise<void>`. `args` is **always a `string`** — the text after the command name, or `""` when none was given. It is never `undefined`. Use `args.trim()` to test for "no argument" rather than `args || ...`, which falsely implies it can be falsy/undefined.

If multiple extensions register the same command name, Wolli keeps them all and assigns numeric invocation suffixes in load order, for example `/review:1` and `/review:2`.

```typescript
wolli.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, { session, ui }) => {
    const count = session.sessionManager.getEntries().length;
    ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`:

```typescript
import type { AutocompleteItem } from "@opsyhq/tui";

wolli.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, { ui }) => {
    ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### wolli.registerMessageRenderer(customType, renderer)

Register a custom TUI renderer for messages with your `customType`. See [Custom UI](#custom-ui).

### wolli.registerShortcut(shortcut, options)

Register a keyboard shortcut.

```typescript
wolli.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async ({ ui }) => {
    ui.notify("Toggled!");
  },
});
```

### wolli.registerFlag(name, options) / wolli.getFlag(name)

Register a CLI flag and read its value.

```typescript
wolli.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (wolli.getFlag("plan")) {
  // Plan mode enabled
}
```

### wolli.cwd / wolli.environments / wolli.modelRegistry

Agent-global, read-only.

- `wolli.cwd` - the agent's home directory, where its files and the file/shell tools operate.
- `wolli.environments` - the full run-target map (type `AgentEnvironments`), including the unconfined `host` target. Reach a specific target via `wolli.environments.targets[...]`.
- `wolli.modelRegistry` - model registry for API key resolution and provider registration.

### wolli.getSession(id) / wolli.openSession(id) / wolli.createSession(options?) / wolli.listSessions() / wolli.findSessions(filter)

Find, open, create, and list sessions. These are the agent-global session-discovery methods — use them from callbacks that run without a handler context (for example, integration `.on(...)` listeners).

- `wolli.getSession(id)` returns a resident (in-memory) `Session` by id, or `undefined` when it is not currently resident. Find-only — never creates or loads.
- `wolli.openSession(id)` rehydrates a stored session by id into the resident set (or returns it if already resident), resolving to a `Session`.
- `wolli.createSession(options?)` starts a fresh stored session and makes it resident. Additive — other sessions stay live. Accepts the same `NewSessionOptions` as `session.newSession()`.
- `wolli.listSessions()` returns the stored sessions for this agent (newest first) as `SessionInfo[]`.
- `wolli.findSessions(filter)` locates stored sessions whose folded tags subset-match `filter`, each with `tags` populated — for example, the session another extension bound to an external conversation via `session.setTags(...)`.

```typescript
// Reach (or create) the session bound to an external chat, from a background callback.
const [match] = await wolli.findSessions({ "telegram:chat": String(chatId) });
const session = match ? await wolli.openSession(match.id) : await wolli.createSession();
await session.sendUserMessage("Triggered from a background callback");
```

`SessionInfo` has the shape `{ id: string; createdAt: string; tags: Record<string, string> }`. `tags` is `{}` from the plain `listSessions()` listing and populated by `findSessions()`.

### wolli.reload() / wolli.shutdown()

- `wolli.reload()` runs the same reload flow as `/reload` (see [session.reload()](#sessionreload)). Use this at the agent-global level.
- `wolli.shutdown()` requests a graceful shutdown of Wolli.
  - **Interactive mode:** Deferred until the agent becomes idle (after processing all queued steering and follow-up messages).
  - **Print mode:** No-op. The process exits automatically when all prompts are processed.

  Emits `session_shutdown` to all extensions before exiting. Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
wolli.on("tool_call", (event) => {
  if (isFatal(event.input)) {
    wolli.shutdown();
  }
});
```

### wolli.registerProvider(name, config) / wolli.unregisterProvider(name)

Register, override, or remove a model provider. See the inline examples in the `@opsyhq/wolli` type definitions for `ProviderConfig` (custom models, baseUrl overrides, and OAuth). To make a registered provider's models usable, log in with `/login` (subscription/OAuth) or supply the provider's API key; OAuth providers registered via `config.oauth` surface in `/login`.

### wolli.getIntegration(name, account?)

Get a handle to a configured integration. See [integrations.md](integrations.md#consuming-an-integration) for the full surface (`.on(event, handler)`, `.call(action, params)`, account resolution, and binding sessions to external conversations).

### wolli.events

Shared event bus for communication between extensions:

```typescript
wolli.events.on("my:event", (data) => { ... });
wolli.events.emit("my:event", { ... });
```

## State Management

Extensions with state should store it in tool result `details` for proper branching support:

```typescript
export default function (wolli: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  wolli.on("session_start", async (_event, { session }) => {
    items = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  wolli.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

### Restoring state written by a command (sendMessage)

The loop above only matches tool-result `details`. State you persisted with `session.sendMessage(...)` from a command does **not** appear as a `toolResult` message — it is stored as a separate entry kind. In `getBranch()` / `getEntries()` a `sendMessage` custom message surfaces as a `CustomMessageEntry`:

```typescript
wolli.on("session_start", (_event, { session }) => {
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "custom_message" && entry.customType === "my-extension") {
      // entry.content - string | (TextContent | ImageContent)[]
      // entry.details - the payload you passed to sendMessage
      // entry.display - boolean
      const restored = entry.details as { notes?: string[] };
      // reconstruct from restored.notes...
    }
  }
});
```

> The on-disk entry type is `"custom_message"` with top-level `customType` / `content` / `details` / `display` fields. It is **not** a `type: "message"` entry with `message.role === "custom"`, so a reconstruction loop that only scans `entry.type === "message" && entry.message.role === "toolResult"` (the pattern above) will silently never match command-written state. Match `entry.type === "custom_message"` to restore it. `appendEntry` state is different again — it surfaces as `entry.type === "custom"` with `entry.customType` / `entry.data` (see [session.appendEntry](#sessionappendentrycustomtype-data)).

## Custom Tools

Register tools the LLM can call via `wolli.registerTool()`. Tools appear in the system prompt and can have custom rendering.

Use `promptSnippet` for a short one-line entry in the `Available tools` section in the default system prompt. If omitted, custom tools are left out of that section.

Use `promptGuidelines` to add tool-specific bullets to the default system prompt `Guidelines` section. These bullets are included only while the tool is active (for example, after `ctx.session.setActiveTools([...])`).

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix or grouping. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

Note: Some models include an `@` prefix in tool path arguments. Built-in tools strip a leading `@` before resolving paths. If your custom tool accepts a path, normalize a leading `@` as well.

If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in `edit` and `write`. This matters because tool calls run in parallel by default. Without the queue, two tools can read the same old file contents, compute different updates, and then whichever write lands last overwrites the other.

Example failure case: your custom tool edits `foo.ts` while built-in `edit` also changes `foo.ts` in the same assistant turn. If your tool does not participate in the queue, both can read the original `foo.ts`, apply separate changes, and one of those changes is lost.

Pass the real target file path to `withFileMutationQueue()`, not the raw user argument. Resolve it to an absolute path first, relative to `wolli.cwd` or your tool's working directory. For existing files, the helper canonicalizes through `realpath()`, so symlink aliases for the same file share one queue. For new files, it falls back to the resolved absolute path because there is nothing to `realpath()` yet.

Queue the entire mutation window on that target path. That includes read-modify-write logic, not just the final write.

```typescript
import { withFileMutationQueue } from "@opsyhq/wolli";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(wolli.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Tool Definition

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@opsyhq/tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

wolli.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Use StringEnum for Google compatibility
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    }

    // Stream progress updates
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Run commands with Node's child_process
    const result = await execFileAsync("some-command", [], { signal });

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM
      details: { data: result },                   // For rendering & state
      // Optional: stop after this tool batch when every finalized tool result
      // in the batch also returns terminate: true.
      terminate: true,
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**`details` is required:** `execute()` (and the `onUpdate?.(...)` partial-result callback) return an `AgentToolResult<T>`, whose `details: T` field is **non-optional**. Every return — including early-exit and cancellation paths — must include `details`. If your tool has no structured payload, return `details: {}` (or `details: undefined` when `T` permits it). Omitting it is a type error, not a defaulted field.

**Signaling errors:** To mark a tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an error from `execute`. Returning a value never sets the error flag regardless of what properties you include in the return object.

**Early termination:** Return `terminate: true` from `execute()` to hint that the automatic follow-up LLM call should be skipped after the current tool batch. This only takes effect when every finalized tool result in that batch is terminating. This is useful when the agent should end on a final structured-output tool call.

```typescript
// Correct: throw to signal an error
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**Important:** Use `StringEnum` from `@earendil-works/pi-ai` for string enums. `Type.Union`/`Type.Literal` doesn't work with Google's API.

**Argument preparation:** `prepareArguments(args)` is optional. If defined, it runs before schema validation and before `execute()`. Use it to mimic an older accepted input shape when Wolli resumes an older session whose stored tool call arguments no longer match the current schema. Return the object you want validated against `parameters`. Keep the public schema strict. Do not add deprecated compatibility fields to `parameters` just to keep old resumed sessions working.

Example: an older session may contain an `edit` tool call with top-level `oldText` and `newText`, while the current schema only accepts `edits: [{ oldText, newText }]`.

```typescript
wolli.registerTool({
  name: "edit",
  label: "Edit",
  description: "Edit a single file using exact text replacement",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params now matches the current schema
    return {
      content: [{ type: "text", text: `Applying ${params.edits.length} edit block(s)` }],
      details: {},
    };
  },
});
```

### Overriding Built-in Tools

Extensions can override built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) by registering a tool with the same name. Interactive mode displays a warning when this happens.

**Rendering:** Built-in renderer inheritance is resolved per slot. Execution override and rendering override are independent. If your override omits `renderCall`, the built-in `renderCall` is used. If your override omits `renderResult`, the built-in `renderResult` is used. If your override omits both, the built-in renderer is used automatically (syntax highlighting, diffs, etc.). This lets you wrap built-in tools for logging or access control without reimplementing the UI.

**Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. If your override should keep those prompt instructions, define them on the override explicitly.

**Your implementation must match the exact result shape**, including the `details` type. The UI and session logic depend on these shapes for rendering and state tracking. The built-in tool details types (`ReadToolDetails`, `BashToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`, etc.) are exported from `@opsyhq/wolli`.

### The Environment seam

Every built-in file/shell tool (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`) consumes a single `Environment` instead of its own per-tool operations. The `Environment` decides where reads/writes/exec land — the host filesystem today, a sandbox or remote backend later. The agent's run-target map is exposed as `wolli.environments` (type `AgentEnvironments`): `wolli.environments.targets[...]` reaches a specific target, and `wolli.environments.default` names the target tools use when none is specified.

```typescript
import { createBashTool, createReadTool, type Environment } from "@opsyhq/wolli";

// Reach the default target environment, then build a tool against a custom
// environment (e.g. one that wraps exec)
const base = wolli.environments.targets[wolli.environments.default];
const env: Environment = {
  ...base,
  exec: (command, cwd, options) => base.exec(`source ~/.profile\n${command}`, cwd, options),
};
const customBash = createBashTool(env);
```

`createHostEnvironment(cwd, { shellPath? })` builds the default unconfined host backend. An `Environment` provides `exec`, `readFile`, `writeFile`, `mkdir`, `access`, `exists`, `stat`, `readdir`, an optional `detectImageMimeType`, plus `id`/`cwd`/`resolvePath`. Override any of these (spreading a target from `wolli.environments` for the rest) to delegate tools to a different backend.

For `user_bash`, return `{ environment }` from the handler to run the command in a custom environment, or reuse `createHostEnvironment()` instead of reimplementing local process spawning, shell resolution, and process-tree termination.

The bash tool also supports a spawn hook to adjust the command, cwd, or env before execution:

```typescript
import { createBashTool, createHostEnvironment } from "@opsyhq/wolli";

const env = createHostEnvironment(wolli.cwd);
const bashTool = createBashTool(env, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

### Output Truncation

**Tools MUST truncate their output** to avoid overwhelming the LLM context. Large outputs can cause:
- Context overflow errors (prompt too long)
- Compaction failures
- Degraded model performance

The built-in limit is **50KB** (~10k tokens) and **2000 lines**, whichever is hit first. Use the exported truncation utilities:

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (good for file reads, search results)
  truncateTail,      // Keep last N lines/bytes (good for logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size (e.g., "50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@opsyhq/wolli";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // Apply truncation
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // Write full output to temp file
    const tempFile = writeTempFile(output);

    // Inform the LLM where to find complete output
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**Key points:**
- Use `truncateHead` for content where the beginning matters (search results, file reads)
- Use `truncateTail` for content where the end matters (logs, command output)
- Always inform the LLM when output is truncated and where to find the full version
- Document the truncation limits in your tool's description

### Multiple Tools

One extension can register multiple tools with shared state:

```typescript
export default function (wolli: ExtensionAPI) {
  let connection = null;

  wolli.registerTool({ name: "db_connect", ... });
  wolli.registerTool({ name: "db_query", ... });
  wolli.registerTool({ name: "db_close", ... });

  wolli.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### Custom Rendering

Tools can provide `renderCall` and `renderResult` for custom TUI display.

By default, tool output is wrapped in a `Box` that handles padding and background. A defined `renderCall` or `renderResult` must return a `Component`. If a slot renderer is not defined, fallback rendering is used for that slot.

Set `renderShell: "self"` when the tool should render its own shell instead of using the default `Box`. This is useful for tools that need complete control over framing or background behavior, for example large previews that must stay visually stable after the tool settles.

```typescript
wolli.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` and `renderResult` each receive a `context` object with:
- `args` - the current tool call arguments
- `state` - shared row-local state across `renderCall` and `renderResult`
- `lastComponent` - the previously returned component for that slot, if any
- `invalidate()` - request a rerender of this tool row
- `toolCallId`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`

Use `context.state` for cross-slot shared state. Keep slot-local caches on the returned component instance when you want to reuse and mutate the same component across renders.

#### renderCall

Renders the tool call or header:

```typescript
import { Text } from "@opsyhq/tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

Renders the tool result or output:

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

If a slot intentionally has no visible content, return an empty `Component` such as an empty `Container`.

#### Keybinding Hints

Use `keyHint()` to display keybinding hints that respect the active keybinding configuration:

```typescript
import { keyHint } from "@opsyhq/wolli";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded) {
    text += ` (${keyHint("app.tools.expand", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

Available functions:
- `keyHint(keybinding, description)` - Formats a configured keybinding id such as `"app.tools.expand"` or `"tui.select.confirm"`
- `keyText(keybinding)` - Returns the raw configured key text for a keybinding id
- `rawKeyHint(key, description)` - Format a raw key string

Use namespaced keybinding ids:
- App ids use the `app.*` namespace, for example `app.tools.expand`, `app.editor.external`, `app.session.rename`
- Shared TUI ids use the `tui.*` namespace, for example `tui.select.confirm`, `tui.select.cancel`, `tui.input.tab`

Custom editors and `ctx.ui.custom()` components receive `keybindings: KeybindingsManager` as an injected argument. They should use that injected manager directly instead of calling `getKeybindings()` or `setKeybindings()`.

#### Best Practices

- Use `Text` with padding `(0, 0)`. The default Box handles padding.
- Use `\n` for multi-line content.
- Handle `isPartial` for streaming progress.
- Support `expanded` for detail on demand.
- Keep default view compact.
- Read `context.args` in `renderResult` instead of copying args into `context.state`.
- Use `context.state` only for data that must be shared across call and result slots.
- Reuse `context.lastComponent` when the same component instance can be updated in place.
- Use `renderShell: "self"` only when the default boxed shell gets in the way. In self-shell mode the tool is responsible for its own framing, padding, and background.

#### Fallback

If a slot renderer is not defined or throws:
- `renderCall`: Shows the tool name
- `renderResult`: Shows raw text from `content`

## Custom UI

Extensions can interact with users via `ctx.ui` methods and customize how messages/tools render.

### Dialogs

```typescript
// Select from options
const choice = await ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ui.editor("Edit:", "prefilled text");

// Notification (non-blocking)
ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

#### Timed Dialogs with Countdown

Dialogs support a `timeout` option that auto-dismisses with a live countdown display:

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
const confirmed = await ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // User confirmed
} else {
  // User cancelled or timed out
}
```

**Return values on timeout:**
- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` returns `undefined`

#### Manual Dismissal with AbortSignal

For more control (e.g., to distinguish timeout from user cancel), use `AbortSignal`:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Dialog timed out
} else {
  // User cancelled (pressed Escape or selected "No")
}
```

### Widgets, Status, and Footer

```typescript
// Status in footer (persistent until cleared)
ui.setStatus("my-ext", "Processing...");
ui.setStatus("my-ext", undefined);  // Clear

// Working loader (shown during streaming)
ui.setWorkingMessage("Thinking deeply...");
ui.setWorkingMessage();  // Restore default
ui.setWorkingVisible(false);  // Hide the built-in working loader row entirely
ui.setWorkingVisible(true);   // Show the built-in working loader row

// Working indicator (shown during streaming)
ui.setWorkingIndicator({ frames: [ui.theme.fg("accent", "●")] });  // Static dot
ui.setWorkingIndicator({
  frames: [
    ui.theme.fg("dim", "·"),
    ui.theme.fg("muted", "•"),
    ui.theme.fg("accent", "●"),
    ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ui.setWorkingIndicator({ frames: [] });  // Hide indicator
ui.setWorkingIndicator();  // Restore default spinner

// Widget above editor (default)
ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// Widget below editor
ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ui.setWidget("my-widget", undefined);  // Clear

// Custom footer (replaces built-in footer entirely)
ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
ui.setFooter(undefined);  // Restore built-in footer

// Terminal title
ui.setTitle("wolli - my-agent");

// Editor text
ui.setEditorText("Prefill text");
const current = ui.getEditorText();

// Paste into editor (triggers paste handling, including collapse for large content)
ui.pasteToEditor("pasted content");

// Stack custom autocomplete behavior on top of the built-in provider
ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#2983", label: "#2983", description: "Extension API for autocomplete" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// Tool output expansion
const wasExpanded = ui.getToolsExpanded();
ui.setToolsExpanded(true);
ui.setToolsExpanded(wasExpanded);

// Custom editor (vim mode, emacs mode, etc.)
ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ui.getEditorComponent();
ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ui.setEditorComponent(undefined);  // Restore default editor

// Theme management (see themes.md for creating themes)
const themes = ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ui.getTheme("light");  // Load without switching
const result = ui.setTheme("light");  // Switch by name
if (!result.success) {
  ui.notify(`Failed: ${result.error}`, "error");
}
ui.setTheme(lightTheme!);  // Or switch by Theme object
ui.theme.fg("accent", "styled text");  // Access current theme
```

Custom working-indicator frames are rendered verbatim. If you want colors, add them to the frame strings yourself, for example with `ui.theme.fg(...)`.

### Autocomplete Providers

Use `ui.addAutocompleteProvider()` to stack custom autocomplete logic on top of the built-in slash-command and path provider. Set `triggerCharacters` for custom natural triggers such as `$`.

Typical pattern:

- inspect the text before the cursor
- return your own suggestions when your extension-specific syntax matches
- otherwise delegate to `current.getSuggestions(...)`
- delegate `applyCompletion(...)` unless you need custom insertion behavior

```typescript
wolli.on("session_start", (_event, { ui }) => {
  ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#2983", label: "#2983", description: "Extension API for registering custom @ autocomplete providers" },
          { value: "#2753", label: "#2753", description: "Reload stale resource settings" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

A typical real-world provider preloads the latest open GitHub issues with `gh issue list` and filters them locally for fast `#...` completion, which requires GitHub CLI (`gh`) and a GitHub repository checkout.

### Custom Components

For complex UI, use `ctx.ui.custom()`. This temporarily replaces the editor with your component until `done()` is called:

```typescript
import { Text, Component } from "@opsyhq/tui";

const result = await ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("Press Enter to confirm, Escape to cancel", 1, 1);

  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };

  return text;
});

if (result) {
  // User pressed Enter
}
```

The callback receives:
- `tui` - TUI instance (for screen dimensions, focus management)
- `theme` - Current theme for styling
- `keybindings` - App keybinding manager (for checking shortcuts)
- `done(value)` - Call to close component and return value

### Custom Editor

Replace the main input editor with a custom implementation (vim mode, emacs mode, etc.):

```typescript
import { CustomEditor, type ExtensionAPI } from "@opsyhq/wolli";
import { matchesKey } from "@opsyhq/tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return;
    }
    super.handleInput(data);  // App keybindings + text editing
  }
}

export default function (wolli: ExtensionAPI) {
  wolli.on("session_start", (_event, { ui }) => {
    ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**Key points:**
- Extend `CustomEditor` (not base `Editor`) to get app keybindings (escape to abort, ctrl+d, model switching)
- Call `super.handleInput(data)` for keys you don't handle
- Factory receives `(tui, theme, keybindings)` from the app
- Use `ui.getEditorComponent()` before `setEditorComponent()` to wrap the previously configured custom editor
- Pass `undefined` to restore default: `ui.setEditorComponent(undefined)`

To compose with another extension that already replaced the editor, capture the previous factory before setting yours:

```typescript
const previous = ui.getEditorComponent();
ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

### Message Rendering

Register a custom renderer for messages with your `customType`:

```typescript
import { Text } from "@opsyhq/tui";

wolli.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, 0, 0);
});
```

Messages are sent via `ctx.session.sendMessage()`:

```typescript
session.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

**Default rendering (no registered renderer).** Registering a renderer is optional. A `display: true` custom message with no renderer for its `customType` still appears in the TUI: it renders in a boxed message with a bold `[customType]` label header, followed by the message `content` rendered as markdown (text parts only, for array content). So you can see `/command` output without registering anything; register a renderer only when you want custom styling, an expanded view, or to surface `details`. The same fallback applies if your renderer throws or returns nothing. Messages sent with `display: false` are not rendered at all.

### Theme Colors

All render functions receive a `theme` object. See [themes.md](themes.md) for creating custom themes and the full color palette.

```typescript
// Foreground colors
theme.fg("toolTitle", text)   // Tool names
theme.fg("accent", text)      // Highlights
theme.fg("success", text)     // Success (green)
theme.fg("error", text)       // Errors (red)
theme.fg("warning", text)     // Warnings (yellow)
theme.fg("muted", text)       // Secondary text
theme.fg("dim", text)         // Tertiary text

// Text styles
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

For syntax highlighting in custom tool renderers:

```typescript
import { highlightCode, getLanguageFromPath } from "@opsyhq/wolli";

// Highlight code with explicit language (returns an array of styled lines;
// uses the active theme internally, so no theme argument is passed)
const lines: string[] = highlightCode("const x = 1;", "typescript");

// Auto-detect language from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlightedLines = highlightCode(code, lang);
```

## Error Handling

- Extension errors are logged, agent continues
- `tool_call` errors block the tool (fail-safe)
- Tool `execute` errors must be signaled by throwing; the thrown error is caught, reported to the LLM with `isError: true`, and execution continues

## Mode Behavior

`ctx.mode` is one of four run modes. Use `ctx.mode === "tui"` before any terminal-only feature (`custom()`, component factories, terminal input, direct TUI rendering). In non-`tui` modes, dialog methods resolve to their inert defaults (`select`/`input`/`editor` return `undefined`, `confirm` returns `false`) and fire-and-forget UI calls (`notify`, `setStatus`, `setWidget`, `setTitle`) are no-ops, so guarding by mode keeps an extension from blocking on UI that cannot appear.

| Mode | `ctx.mode` | Notes |
|------|-----------|-------|
| Interactive | `"tui"` | Full TUI with terminal rendering; dialogs and custom components are available |
| RPC | `"rpc"` | Programmatic host drives the session over RPC; no terminal UI |
| JSON | `"json"` | Structured JSON stream output; no terminal UI |
| Print (`-p`) | `"print"` | One-shot/headless; extensions run but cannot prompt the user |

## Worked Examples

These examples combine the pieces above against the real `@opsyhq/wolli` surface.

### Bind a session to an external conversation

Use folded tags plus `wolli.findSessions` / `openSession` / `createSession` to route an external chat to a stable session, with no live `ctx` in scope.

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

export default function (wolli: ExtensionAPI) {
  const telegram = wolli.getIntegration("telegram", "default");

  telegram.on("message", async (msg) => {
    const key = String(msg.chatId);
    const [match] = await wolli.findSessions({ "telegram:chat": key });

    const session = match
      ? await wolli.openSession(match.id)
      : await wolli.createSession({
          withSession: async (s) => { s.setTags({ "telegram:chat": key }); },
        });

    await session.sendUserMessage(msg.text);
  });
}
```

See [integrations.md](integrations.md#consuming-an-integration) for the integration handle surface.

### Permission gate on a custom tool

Block a dangerous bash command unless the user confirms, using `ctx.ui` and the `tool_call` block result.

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";
import { isToolCallEventType } from "@opsyhq/wolli";

export default function (wolli: ExtensionAPI) {
  wolli.on("tool_call", async (event, { ui, mode }) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!/\brm\s+-rf\b/.test(event.input.command)) return;

    // In non-tui modes confirm() resolves false, which blocks fail-safe.
    const ok = mode === "tui"
      ? await ui.confirm("Dangerous command", `Run: ${event.input.command}?`)
      : false;

    if (!ok) return { block: true, reason: "Blocked rm -rf" };
  });
}
```

### Persist and restore extension state

Store state in tool result `details`, then rebuild it from the branch on `session_start`.

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";
import { Type } from "typebox";

export default function (wolli: ExtensionAPI) {
  let todos: string[] = [];

  wolli.on("session_start", (_event, { session }) => {
    todos = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_add") {
        todos = (entry.message.details as { todos?: string[] })?.todos ?? todos;
      }
    }
  });

  wolli.registerTool({
    name: "todo_add",
    label: "Add Todo",
    description: "Append an item to the session todo list",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      todos.push(params.text);
      return {
        content: [{ type: "text", text: `Added: ${params.text}` }],
        details: { todos: [...todos] },
      };
    },
  });
}
```
