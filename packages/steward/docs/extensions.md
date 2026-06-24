# Extensions

Extensions are TypeScript modules that extend Steward's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more.

> **Placement for /reload:** Put extensions in an agent's `~/.steward/agents/<name>/extensions/` for auto-discovery. Use `--extension ./path.ts` only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

**Key capabilities:**
- **Custom tools** - Register tools the LLM can call via `steward.registerTool()`
- **Event interception** - Block or modify tool calls, inject context, customize compaction
- **User interaction** - Prompt users via `conversation.ui` (select, confirm, input, notify)
- **Custom UI components** - Full TUI components with keyboard input via `conversation.ui.custom()` for complex interactions
- **Custom commands** - Register commands like `/mycommand` via `steward.registerCommand()`
- **Session persistence** - Store state that survives restarts via `conversation.appendEntry()`
- **Custom rendering** - Control how tool calls/results and messages appear in TUI

**Example use cases:**
- Permission gates (confirm before `rm -rf`, `sudo`, etc.)
- Git checkpointing (stash at each turn, restore on branch)
- Path protection (block writes to `.env`, `node_modules/`)
- Custom compaction (summarize conversation your way)
- Interactive tools (questions, wizards, custom dialogs)
- Stateful tools (todo lists, connection pools)
- External integrations (file watchers, webhooks, CI triggers)

> **Note:** The extension factory's first argument is named `steward` throughout this document. That name is just a convention for the extension API object — call it whatever you like. (The package.json manifest key used to declare extensions is `"steward"`; that key name is fixed and unrelated to the argument name.)
>
> Every event handler, command, shortcut, and custom-tool `execute` receives a context bag as its last argument: `context: ExtensionContext`, where `ExtensionContext = { conversation: Conversation }`. Examples destructure it as `{ conversation }`. The `conversation` carries the per-conversation surface (`ui`, `sessionManager`, `model`, `sendMessage`, `compact`, etc.); agent-global capabilities live on `steward`.

## Table of Contents

- [Quick Start](#quick-start)
- [Extension Locations](#extension-locations)
- [Available Imports](#available-imports)
- [Writing an Extension](#writing-an-extension)
  - [Extension Styles](#extension-styles)
- [Events](#events)
  - [Lifecycle Overview](#lifecycle-overview)
  - [Session Events](#session-events)
  - [Agent Events](#agent-events)
  - [Model Events](#model-events)
  - [Tool Events](#tool-events)
- [Context and Conversation](#context-and-conversation)
- [API Reference](#api-reference)
- [State Management](#state-management)
- [Custom Tools](#custom-tools)
- [Custom UI](#custom-ui)
- [Error Handling](#error-handling)
- [Mode Behavior](#mode-behavior)

## Quick Start

Create `~/.steward/agents/<name>/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@opsyhq/steward";
import { Type } from "typebox";

export default function (steward: ExtensionAPI) {
  // React to events
  steward.on("session_start", async (_event, { conversation }) => {
    conversation.ui.notify("Extension loaded!", "info");
  });

  steward.on("tool_call", async (event, { conversation }) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await conversation.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  steward.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, { conversation }) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  steward.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, { conversation }) => {
      conversation.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test with `--extension` (or `-e`) flag:

```bash
steward <name> -e ./my-extension.ts
```

## Extension Locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Extensions are auto-discovered from the agent's own home, because each agent owns its extensions. There is no project-local extension location.

| Location | Scope |
|----------|-------|
| `~/.steward/agents/<name>/extensions/*.ts` | The agent (all sessions) |
| `~/.steward/agents/<name>/extensions/*/index.ts` | The agent (subdirectory) |

Additional paths via `settings.json`:

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
| `@opsyhq/steward` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@earendil-works/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@opsyhq/tui` | TUI components for custom rendering |

npm dependencies work too. Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically.

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.

## Writing an Extension

An extension exports a default factory function that receives `ExtensionAPI`. The factory can be synchronous or asynchronous:

```typescript
import type { ExtensionAPI } from "@opsyhq/steward";

export default function (steward: ExtensionAPI) {
  // Subscribe to events
  steward.on("event_name", async (event, { conversation }) => {
    // conversation.ui for user interaction
    const ok = await conversation.ui.confirm("Title", "Are you sure?");
    conversation.ui.notify("Done!", "info");
    conversation.ui.setStatus("my-ext", "Processing...");  // Footer status
    conversation.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  steward.registerTool({ ... });
  steward.registerCommand("name", { ... });
  steward.registerShortcut("ctrl+x", { ... });
  steward.registerFlag("my-flag", { ... });
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

If the factory returns a `Promise`, Steward awaits it before continuing startup. That means async initialization completes before `session_start`.

### Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration.

```typescript
import type { ExtensionAPI } from "@opsyhq/steward";

export default async function (steward: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/config");
  const config = await response.json();
  // Use config to set up tools, commands, etc.
}
```

### Extension Styles

**Single file** - simplest, for small extensions:

```
~/.steward/agents/<name>/extensions/
└── my-extension.ts
```

**Directory with index.ts** - for multi-file extensions:

```
~/.steward/agents/<name>/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies** - for extensions that need npm packages:

```
~/.steward/agents/<name>/extensions/
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
  "steward": {
    "extensions": ["./src/index.ts"]
  }
}
```

Run `npm install` in the extension directory, then imports from `node_modules/` work automatically.

## Events

### Lifecycle Overview

```
Steward starts
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

/new (new session) or /resume (switch session)
  ├─► session_shutdown
  └─► session_start { reason: "new" | "resume", previousSessionFile? }

/compact or auto-compaction
  └─► session_before_compact (can cancel or customize)

/model or Ctrl+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, conversation.setThinkingLevel())
  └─► thinking_level_select

exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### Session Events

#### session_start

Fired when a session is started, loaded, or reloaded.

```typescript
steward.on("session_start", async (event, { conversation }) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - present for "new", "resume", and "fork"
  conversation.ui.notify(`Session: ${conversation.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

After a successful switch or new-session action, Steward emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "new" | "resume"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_compact

Fired on compaction. **Can cancel or customize.**

```typescript
steward.on("session_before_compact", async (event, { conversation }) => {
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
steward.on("session_shutdown", async (event, { conversation }) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
  // Cleanup, save state, etc.
});
```

### Agent Events

#### before_agent_start

Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt.

```typescript
steward.on("before_agent_start", async (event, { conversation }) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .customPrompt - any custom system prompt
  //   .selectedTools - tools currently active in the prompt
  //   .toolSnippets - one-line descriptions for each tool
  //   .promptGuidelines - custom guideline bullets
  //   .appendSystemPrompt - text from --append-system-prompt flags
  //   .cwd - working directory
  //   .contextFiles - context files loaded into the prompt
  //   .skills - loaded skills

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

The `systemPromptOptions` field gives extensions access to the same structured data Steward uses to build the system prompt. This lets you inspect what Steward has loaded — custom prompts, guidelines, tool snippets, context files, skills — without re-discovering resources or re-parsing flags. Use it when your extension needs to make deep, informed changes to the system prompt while respecting user-provided configuration.

Inside `before_agent_start`, `event.systemPrompt` and `conversation.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again.

#### agent_start / agent_end

Fired once per user prompt.

```typescript
steward.on("agent_start", async (_event, { conversation }) => {});

steward.on("agent_end", async (event, { conversation }) => {
  // event.messages - messages from this prompt
});
```

#### turn_start / turn_end

Fired for each turn (one LLM response + tool calls).

```typescript
steward.on("turn_start", async (event, { conversation }) => {
  // event.turnIndex, event.timestamp
});

steward.on("turn_end", async (event, { conversation }) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

Fired for message lifecycle updates.

- `message_start` and `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming updates.
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`.

```typescript
steward.on("message_start", async (event, { conversation }) => {
  // event.message
});

steward.on("message_update", async (event, { conversation }) => {
  // event.message
  // event.assistantMessageEvent (token-by-token stream event)
});

steward.on("message_end", async (event, { conversation }) => {
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
steward.on("tool_execution_start", async (event, { conversation }) => {
  // event.toolCallId, event.toolName, event.args
});

steward.on("tool_execution_update", async (event, { conversation }) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

steward.on("tool_execution_end", async (event, { conversation }) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

Fired before each LLM call. Modify messages non-destructively.

```typescript
steward.on("context", async (event, { conversation }) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_request

Fired after the provider-specific payload is built, right before the request is sent. Handlers run in extension load order. Returning `undefined` keeps the payload unchanged. Returning any other value replaces the payload for later handlers and for the actual request.

This hook can rewrite provider-level system instructions or remove them entirely. Those payload-level changes are not reflected by `conversation.getSystemPrompt()`, which reports Steward's system prompt string rather than the final serialized provider payload.

```typescript
steward.on("before_provider_request", (event, { conversation }) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

This is mainly useful for debugging provider serialization and cache behavior.

### Model Events

#### model_select

Fired when the model changes via `/model` command, model cycling (`Ctrl+P`), or session restore.

```typescript
steward.on("model_select", async (event, { conversation }) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  conversation.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

Use this to update UI elements (status bars, footers) or perform model-specific initialization when the active model changes.

#### thinking_level_select

Fired when the thinking level changes. This is notification-only; handler return values are ignored.

```typescript
steward.on("thinking_level_select", async (event, { conversation }) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  conversation.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Use this to update extension UI when `conversation.setThinkingLevel()`, model changes, or built-in thinking-level controls change the active thinking level.

### Tool Events

#### tool_call

Fired after `tool_execution_start`, before the tool executes. **Can block.** Use `isToolCallEventType` to narrow and get typed inputs.

Before `tool_call` runs, Steward waits for previously emitted Agent events to finish draining. This means `conversation.sessionManager` is up to date through the current assistant tool-calling message.

In the default parallel tool execution mode, sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results from that same assistant message in `conversation.sessionManager`.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution.

Behavior guarantees:
- Mutations to `event.input` affect the actual tool execution
- Later `tool_call` handlers see mutations made by earlier handlers
- No re-validation is performed after your mutation
- Return values from `tool_call` only control blocking via `{ block: true, reason?: string }`

```typescript
import { isToolCallEventType } from "@opsyhq/steward";

steward.on("tool_call", async (event, { conversation }) => {
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
import { isToolCallEventType } from "@opsyhq/steward";
import type { MyToolInput } from "my-extension";

steward.on("tool_call", (event) => {
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

Use `conversation.signal` for nested async work inside the handler. This lets Esc cancel model calls, `fetch()`, and other abort-aware operations started by the extension.

```typescript
import { isBashToolResult } from "@opsyhq/steward";

steward.on("tool_result", async (event, { conversation }) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: conversation.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false };
});
```

### User Bash Events

#### user_bash

Fired when user executes `!` or `!!` commands. **Can intercept.**

```typescript
import { createHostEnvironment } from "@opsyhq/steward";

steward.on("user_bash", (event, { conversation }) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Run the command in a custom environment (e.g., a sandbox)
  return { environment: customEnvironment };

  // Option 2: Wrap Steward's host environment to rewrite commands
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
steward.on("input", async (event, { conversation }) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed) or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   undefined when idle, "steer" for mid-stream interrupts,
  //   "followUp" for messages queued until the agent finishes

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    conversation.ui.notify("pong", "info");
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

## Context and Conversation

Every event handler, command, shortcut, and custom-tool `execute` receives a context bag as its last argument: `context: ExtensionContext`, where `ExtensionContext = { conversation: Conversation }`. Destructure it as `{ conversation }`. The `conversation` is the live conversation the handler is acting on, and carries the per-conversation surface described below.

Outside a handler (for example, in an integration `.on(...)` callback registered at load time), there may be no live conversation. Reach it with `steward.getConversation()`, which returns `Conversation | undefined`, and guard with `?.`.

### conversation.ui

UI methods for user interaction. See [Custom UI](#custom-ui) for full details.

### conversation.mode

Current run mode: `"tui"` or `"print"`. Use `conversation.mode === "tui"` to guard terminal-only features such as `custom()`, component factories, terminal input, and direct TUI rendering.

### conversation.hasUI

`true` in TUI mode. `false` in print mode (`-p`). Use this to guard dialog methods (`select`, `confirm`, `input`, `editor`) and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`).

### conversation.sessionManager

Read-only access to session state.

For `tool_call`, this state is synchronized through the current assistant message before handlers run. In parallel tool execution mode it is still not guaranteed to include sibling tool results from the same assistant message.

```typescript
conversation.sessionManager.getEntries()       // All entries
conversation.sessionManager.getBranch()        // Current branch
conversation.sessionManager.getLeafId()        // Current leaf entry ID
```

### conversation.model

The current model, or `undefined`. For the model registry and API keys, use `steward.modelRegistry` (see [API Reference](#api-reference)).

### conversation.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:
- `fetch(..., { signal: conversation.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`conversation.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events, extension commands, and shortcuts fired while Steward is idle.

```typescript
steward.on("tool_result", async (event, { conversation }) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: conversation.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### conversation.prompt(text, options?)

Submit user input through the full command/skill/prompt pipeline, then hand off to the harness.

### conversation.isIdle() / conversation.abort() / conversation.waitForIdle() / conversation.getPendingMessageCount() / conversation.hasPendingMessages()

Control flow helpers.

`conversation.waitForIdle()` waits for the agent to finish streaming:

```typescript
steward.registerCommand("my-cmd", {
  handler: async (args, { conversation }) => {
    await conversation.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### conversation.getContextUsage()

Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages.

```typescript
const usage = conversation.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### conversation.compact()

Trigger compaction without awaiting completion. Use `onComplete` and `onError` for follow-up actions.

```typescript
conversation.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    conversation.ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    conversation.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

### conversation.getSystemPrompt()

Returns Steward's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
steward.on("before_agent_start", (event, { conversation }) => {
  const prompt = conversation.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

### conversation.getSystemPromptOptions()

Returns the base inputs Steward currently uses to build the system prompt.

```typescript
const options = conversation.getSystemPromptOptions();
const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
```

This has the same shape and mutability as `before_agent_start` `event.systemPromptOptions`: custom prompt, active tools, tool snippets, prompt guidelines, appended system prompt text, cwd, loaded context files, and loaded skills. It may include full context file contents, so treat it as sensitive extension-local data and avoid exposing it through command lists, logs, or autocomplete metadata.

This reports the current base prompt inputs. It does not include per-turn `before_agent_start` chained system-prompt changes, later `context` event message mutations, or `before_provider_request` payload rewrites.

### conversation.newSession(options?)

Start a new session, optionally with initialization, and make it the live conversation:

```typescript
const kickoff = "Continue in the replacement session";

const result = await conversation.newSession({
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withConversation: async (conversation) => {
    // Use only the replacement conversation here.
    await conversation.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

Options:
- `setup`: mutate the new session's `SessionManager` before `withConversation` runs
- `withConversation`: run post-switch work against the fresh replacement conversation. Do not use a captured old `conversation`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

### Session replacement lifecycle and footguns

`withConversation` receives the fresh replacement `Conversation`.

Lifecycle and footguns:
- `withConversation` runs only after the old session has emitted `session_shutdown`, the old runtime has been torn down, the replacement session has been rebound, and the new extension instance has already received `session_start`.
- The callback still executes in the original closure, not inside the new extension instance. That means your old extension instance may already have run its shutdown cleanup before `withConversation` starts.
- A captured old `conversation` is stale after replacement and will throw if used. Use only the `conversation` passed to `withConversation` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = conversation.sessionManager` before replacement, `sm` is still the old `SessionManager` object. Do not reuse it after replacement.
- Code in `withConversation` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.

Safe pattern:

```typescript
steward.registerCommand("handoff", {
  handler: async (_args, { conversation }) => {
    const kickoff = "Continue from the replacement session";
    await conversation.newSession({
      withConversation: async (conversation) => {
        await conversation.sendUserMessage(kickoff);
      },
    });
  },
});
```

Unsafe pattern:

```typescript
steward.registerCommand("handoff", {
  handler: async (_args, { conversation }) => {
    const oldSessionManager = conversation.sessionManager;
    await conversation.newSession({
      withConversation: async (_conversation) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        conversation.sendUserMessage("wrong");
      },
    });
  },
});
```

### conversation.reload()

Run the same reload flow as `/reload`.

```typescript
steward.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, and themes",
  handler: async (_args, { conversation }) => {
    await conversation.reload();
    return;
  },
});
```

Important behavior:
- `await conversation.reload()` emits `session_shutdown` for the current extension runtime
- It then reloads resources and emits `session_start` with `reason: "reload"`
- The currently running command handler still continues in the old call frame
- Code after `await conversation.reload()` still runs from the pre-reload version
- Code after `await conversation.reload()` must not assume old in-memory extension state is still valid
- After the handler returns, future commands/events/tool calls use the new extension version

For predictable behavior, treat reload as terminal for that handler (`await conversation.reload(); return;`).

`steward.reload()` runs the same flow without needing a live conversation in scope.

Example tool the LLM can call to trigger reload (tools queue a follow-up command rather than reloading inline):

```typescript
import type { ExtensionAPI } from "@opsyhq/steward";
import { Type } from "typebox";

export default function (steward: ExtensionAPI) {
  steward.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, { conversation }) => {
      await conversation.reload();
      return;
    },
  });

  steward.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, { conversation }) {
      conversation.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## API Reference

Methods are split across two objects. The agent-global ones live on `steward` (the extension factory argument): registration, provider management, integrations, the shared event bus, and find/create access to conversations and sessions.

Per-conversation actions (`sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `setActiveTools`, `setModel`, `setThinkingLevel`, etc.) live on `conversation` instead — destructure `{ conversation }` from a handler's context, or use `steward.getConversation()?.<method>(...)` outside a handler. Both are documented together below; each heading names its owning object.

### steward.on(event, handler)

Subscribe to events. See [Events](#events) for event types and return values.

### steward.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom Tools](#custom-tools) for full details.

`steward.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `conversation.getAllTools()` and are callable by the LLM without `/reload`.

Use `conversation.setActiveTools()` to enable or disable tools (including dynamically added tools) at runtime.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active.

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

steward.registerTool({
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

  async execute(toolCallId, params, signal, onUpdate, { conversation }) {
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

### conversation.sendMessage(message, options?)

Inject a custom message into the session. This is a per-conversation action: destructure `{ conversation }` from a handler, or use `steward.getConversation()?.sendMessage(...)` outside a handler.

```typescript
conversation.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**Options:**
- `deliverAs` - Delivery mode:
  - `"steer"` (default) - Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
  - `"followUp"` - Waits for agent to finish. Delivered only when agent has no more tool calls.
  - `"nextTurn"` - Queued for next user prompt. Does not interrupt or trigger anything.
- `triggerTurn: true` - If agent is idle, trigger an LLM response immediately. Only applies to `"steer"` and `"followUp"` modes (ignored for `"nextTurn"`).

### conversation.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()` which sends custom messages, this sends an actual user message that appears as if typed by the user. Always triggers a turn.

```typescript
// Simple text message
conversation.sendUserMessage("What is 2+2?");

// With content array (text + images)
conversation.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
conversation.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
conversation.sendUserMessage("And then summarize", { deliverAs: "followUp" });
```

**Options:**
- `deliverAs` - Required when agent is streaming:
  - `"steer"` - Queues the message for delivery after the current assistant turn finishes executing its tool calls
  - `"followUp"` - Waits for agent to finish all tools

When not streaming, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, throws an error.

### conversation.appendEntry(customType, data?)

Persist extension state (does NOT participate in LLM context).

```typescript
steward.on("session_start", async (_event, { conversation }) => {
  conversation.appendEntry("my-state", { count: 42 });

  // Restore on reload
  for (const entry of conversation.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

### conversation.setSessionName(name)

Set the session display name (shown in session selector instead of first message).

```typescript
conversation.setSessionName("Refactor auth module");
```

### conversation.getSessionName()

Get the current session name, if set.

```typescript
const name = conversation.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### conversation.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation.

```typescript
// Set a label
conversation.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
conversation.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = conversation.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

### steward.registerCommand(name, options)

Register a command.

If multiple extensions register the same command name, Steward keeps them all and assigns numeric invocation suffixes in load order, for example `/review:1` and `/review:2`.

```typescript
steward.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, { conversation }) => {
    const count = conversation.sessionManager.getEntries().length;
    conversation.ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`:

```typescript
import type { AutocompleteItem } from "@opsyhq/tui";

steward.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, { conversation }) => {
    conversation.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### conversation.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list order is: extensions first, then templates, then skills.

```typescript
const commands = conversation.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

Each entry has this shape:

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

Use `sourceInfo` as the canonical provenance field. Do not infer ownership from command names or from ad hoc path parsing.

Built-in interactive commands (like `/model` and `/settings`) are not included here. They are handled only in interactive
mode and would not execute if sent via `prompt`.

### steward.registerMessageRenderer(customType, renderer)

Register a custom TUI renderer for messages with your `customType`. See [Custom UI](#custom-ui).

### steward.registerShortcut(shortcut, options)

Register a keyboard shortcut.

```typescript
steward.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async ({ conversation }) => {
    conversation.ui.notify("Toggled!");
  },
});
```

### steward.registerFlag(name, options)

Register a CLI flag.

```typescript
steward.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (steward.getFlag("plan")) {
  // Plan mode enabled
}
```

### conversation.getActiveTools() / conversation.getAllTools() / conversation.setActiveTools(names)

Manage active tools. This works for both built-in tools and dynamically registered tools.

```typescript
const active = conversation.getActiveTools();
const all = conversation.getAllTools();
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
conversation.setActiveTools(["read", "bash"]); // Switch to read-only
```

`conversation.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ tools })`
- extension source metadata for tools registered by extensions

### conversation.setModel(model)

Set the current model. Returns `false` if no API key is available for the model.

```typescript
const model = steward.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await conversation.setModel(model);
  if (!success) {
    conversation.ui.notify("No API key for this model", "error");
  }
}
```

### conversation.getThinkingLevel() / conversation.setThinkingLevel(level)

Get or set the thinking level. Level is clamped to model capabilities (non-reasoning models always use "off"). Changes emit `thinking_level_select`.

```typescript
const current = conversation.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
conversation.setThinkingLevel("high");
```

### steward.cwd / steward.environments / steward.modelRegistry

Agent-global, read-only.

- `steward.cwd` - the agent's home directory, where its files and the file/shell tools operate.
- `steward.environments` - the full run-target map (type `AgentEnvironments`), including the unconfined `host` target. Reach a specific target via `steward.environments.targets[...]`.
- `steward.modelRegistry` - model registry for API key resolution and provider registration.

### steward.getConversation() / steward.createConversation() / steward.listSessions()

Find or create conversations and list stored sessions.

- `steward.getConversation()` returns the live `Conversation`, or `undefined` if the agent has not started one. Find-only — never creates. Use it to reach the conversation from callbacks that run without a handler context (for example, integration `.on(...)` listeners).
- `steward.createConversation()` starts a fresh conversation (new stored session) and makes it the live one.
- `steward.listSessions()` returns the stored sessions for this agent (newest first).

```typescript
const conversation = steward.getConversation();
conversation?.sendUserMessage("Triggered from a background callback");
```

### steward.reload() / steward.shutdown()

- `steward.reload()` runs the same reload flow as `/reload` (see [conversation.reload()](#conversationreload)). Use this when no live conversation is in scope.
- `steward.shutdown()` requests a graceful shutdown of Steward.
  - **Interactive mode:** Deferred until the agent becomes idle (after processing all queued steering and follow-up messages).
  - **Print mode:** No-op. The process exits automatically when all prompts are processed.

  Emits `session_shutdown` to all extensions before exiting. Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
steward.on("tool_call", (event) => {
  if (isFatal(event.input)) {
    steward.shutdown();
  }
});
```

### steward.registerProvider(name, config) / steward.unregisterProvider(name)

Register, override, or remove a model provider. See the inline examples in the `@opsyhq/steward` type definitions for `ProviderConfig` (custom models, baseUrl overrides, and OAuth).

### steward.getIntegration(name, account?)

Get a handle to a configured integration `(name, account)` — listen to its events with `.on(event, handler)` and invoke its actions with `.call(action, params)`. `account` defaults to `"default"`.

```typescript
const telegram = steward.getIntegration("telegram", "default");
telegram.on("message", (msg) => steward.getConversation()?.appendEntry("tg_message", msg));
await telegram.call("sendMessage", { chatId, text: "hi" });
```

### steward.events

Shared event bus for communication between extensions:

```typescript
steward.events.on("my:event", (data) => { ... });
steward.events.emit("my:event", { ... });
```

## State Management

Extensions with state should store it in tool result `details` for proper branching support:

```typescript
export default function (steward: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  steward.on("session_start", async (_event, { conversation }) => {
    items = [];
    for (const entry of conversation.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  steward.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, { conversation }) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

## Custom Tools

Register tools the LLM can call via `steward.registerTool()`. Tools appear in the system prompt and can have custom rendering.

Use `promptSnippet` for a short one-line entry in the `Available tools` section in the default system prompt. If omitted, custom tools are left out of that section.

Use `promptGuidelines` to add tool-specific bullets to the default system prompt `Guidelines` section. These bullets are included only while the tool is active (for example, after `conversation.setActiveTools([...])`).

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix or grouping. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

Note: Some models include an `@` prefix in tool path arguments. Built-in tools strip a leading `@` before resolving paths. If your custom tool accepts a path, normalize a leading `@` as well.

If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in `edit` and `write`. This matters because tool calls run in parallel by default. Without the queue, two tools can read the same old file contents, compute different updates, and then whichever write lands last overwrites the other.

Example failure case: your custom tool edits `foo.ts` while built-in `edit` also changes `foo.ts` in the same assistant turn. If your tool does not participate in the queue, both can read the original `foo.ts`, apply separate changes, and one of those changes is lost.

Pass the real target file path to `withFileMutationQueue()`, not the raw user argument. Resolve it to an absolute path first, relative to `steward.cwd` or your tool's working directory. For existing files, the helper canonicalizes through `realpath()`, so symlink aliases for the same file share one queue. For new files, it falls back to the resolved absolute path because there is nothing to `realpath()` yet.

Queue the entire mutation window on that target path. That includes read-modify-write logic, not just the final write.

```typescript
import { withFileMutationQueue } from "@opsyhq/steward";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, { conversation }) {
  const absolutePath = resolve(steward.cwd, params.path);

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

steward.registerTool({
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

  async execute(toolCallId, params, signal, onUpdate, { conversation }) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
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

**Argument preparation:** `prepareArguments(args)` is optional. If defined, it runs before schema validation and before `execute()`. Use it to mimic an older accepted input shape when Steward resumes an older session whose stored tool call arguments no longer match the current schema. Return the object you want validated against `parameters`. Keep the public schema strict. Do not add deprecated compatibility fields to `parameters` just to keep old resumed sessions working.

Example: an older session may contain an `edit` tool call with top-level `oldText` and `newText`, while the current schema only accepts `edits: [{ oldText, newText }]`.

```typescript
steward.registerTool({
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
  async execute(toolCallId, params, signal, onUpdate, { conversation }) {
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

```bash
# Extension's read tool replaces built-in read
steward <name> -e ./tool-override.ts
```

**Rendering:** Built-in renderer inheritance is resolved per slot. Execution override and rendering override are independent. If your override omits `renderCall`, the built-in `renderCall` is used. If your override omits `renderResult`, the built-in `renderResult` is used. If your override omits both, the built-in renderer is used automatically (syntax highlighting, diffs, etc.). This lets you wrap built-in tools for logging or access control without reimplementing the UI.

**Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. If your override should keep those prompt instructions, define them on the override explicitly.

**Your implementation must match the exact result shape**, including the `details` type. The UI and session logic depend on these shapes for rendering and state tracking. The built-in tool details types (`ReadToolDetails`, `BashToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`, etc.) are exported from `@opsyhq/steward`.

### The Environment seam

Every built-in file/shell tool (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`) consumes a single `Environment` instead of its own per-tool operations. The `Environment` decides where reads/writes/exec land — the host filesystem today, a sandbox or remote backend later. The agent's run-target map is exposed as `steward.environments` (type `AgentEnvironments`): `steward.environments.targets[...]` reaches a specific target, and `steward.environments.default` names the target tools use when none is specified.

```typescript
import { createBashTool, createReadTool, type Environment } from "@opsyhq/steward";

// Reach the default target environment, then build a tool against a custom
// environment (e.g. one that wraps exec)
const base = steward.environments.targets[steward.environments.default];
const env: Environment = {
  ...base,
  exec: (command, cwd, options) => base.exec(`source ~/.profile\n${command}`, cwd, options),
};
const customBash = createBashTool(env);
```

`createHostEnvironment(cwd, { shellPath? })` builds the default unconfined host backend. An `Environment` provides `exec`, `readFile`, `writeFile`, `mkdir`, `access`, `exists`, `stat`, `readdir`, an optional `detectImageMimeType`, plus `id`/`cwd`/`resolvePath`. Override any of these (spreading a target from `steward.environments` for the rest) to delegate tools to a different backend.

For `user_bash`, return `{ environment }` from the handler to run the command in a custom environment, or reuse `createHostEnvironment()` instead of reimplementing local process spawning, shell resolution, and process-tree termination.

The bash tool also supports a spawn hook to adjust the command, cwd, or env before execution:

```typescript
import { createBashTool } from "@opsyhq/steward";

const bashTool = createBashTool(cwd, {
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
} from "@opsyhq/steward";

async execute(toolCallId, params, signal, onUpdate, { conversation }) {
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
export default function (steward: ExtensionAPI) {
  let connection = null;

  steward.registerTool({ name: "db_connect", ... });
  steward.registerTool({ name: "db_query", ... });
  steward.registerTool({ name: "db_close", ... });

  steward.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### Custom Rendering

Tools can provide `renderCall` and `renderResult` for custom TUI display.

By default, tool output is wrapped in a `Box` that handles padding and background. A defined `renderCall` or `renderResult` must return a `Component`. If a slot renderer is not defined, fallback rendering is used for that slot.

Set `renderShell: "self"` when the tool should render its own shell instead of using the default `Box`. This is useful for tools that need complete control over framing or background behavior, for example large previews that must stay visually stable after the tool settles.

```typescript
steward.registerTool({
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
import { keyHint } from "@opsyhq/steward";

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

Custom editors and `conversation.ui.custom()` components receive `keybindings: KeybindingsManager` as an injected argument. They should use that injected manager directly instead of calling `getKeybindings()` or `setKeybindings()`.

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

Extensions can interact with users via `conversation.ui` methods and customize how messages/tools render.

### Dialogs

```typescript
// Select from options
const choice = await conversation.ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await conversation.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await conversation.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await conversation.ui.editor("Edit:", "prefilled text");

// Notification (non-blocking)
conversation.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

#### Timed Dialogs with Countdown

Dialogs support a `timeout` option that auto-dismisses with a live countdown display:

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
const confirmed = await conversation.ui.confirm(
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

const confirmed = await conversation.ui.confirm(
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
conversation.ui.setStatus("my-ext", "Processing...");
conversation.ui.setStatus("my-ext", undefined);  // Clear

// Working loader (shown during streaming)
conversation.ui.setWorkingMessage("Thinking deeply...");
conversation.ui.setWorkingMessage();  // Restore default
conversation.ui.setWorkingVisible(false);  // Hide the built-in working loader row entirely
conversation.ui.setWorkingVisible(true);   // Show the built-in working loader row

// Working indicator (shown during streaming)
conversation.ui.setWorkingIndicator({ frames: [conversation.ui.theme.fg("accent", "●")] });  // Static dot
conversation.ui.setWorkingIndicator({
  frames: [
    conversation.ui.theme.fg("dim", "·"),
    conversation.ui.theme.fg("muted", "•"),
    conversation.ui.theme.fg("accent", "●"),
    conversation.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
conversation.ui.setWorkingIndicator({ frames: [] });  // Hide indicator
conversation.ui.setWorkingIndicator();  // Restore default spinner

// Widget above editor (default)
conversation.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// Widget below editor
conversation.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
conversation.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
conversation.ui.setWidget("my-widget", undefined);  // Clear

// Custom footer (replaces built-in footer entirely)
conversation.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
conversation.ui.setFooter(undefined);  // Restore built-in footer

// Terminal title
conversation.ui.setTitle("steward - my-agent");

// Editor text
conversation.ui.setEditorText("Prefill text");
const current = conversation.ui.getEditorText();

// Paste into editor (triggers paste handling, including collapse for large content)
conversation.ui.pasteToEditor("pasted content");

// Stack custom autocomplete behavior on top of the built-in provider
conversation.ui.addAutocompleteProvider((current) => ({
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
const wasExpanded = conversation.ui.getToolsExpanded();
conversation.ui.setToolsExpanded(true);
conversation.ui.setToolsExpanded(wasExpanded);

// Custom editor (vim mode, emacs mode, etc.)
conversation.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = conversation.ui.getEditorComponent();
conversation.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
conversation.ui.setEditorComponent(undefined);  // Restore default editor

// Theme management (see themes.md for creating themes)
const themes = conversation.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = conversation.ui.getTheme("light");  // Load without switching
const result = conversation.ui.setTheme("light");  // Switch by name
if (!result.success) {
  conversation.ui.notify(`Failed: ${result.error}`, "error");
}
conversation.ui.setTheme(lightTheme!);  // Or switch by Theme object
conversation.ui.theme.fg("accent", "styled text");  // Access current theme
```

Custom working-indicator frames are rendered verbatim. If you want colors, add them to the frame strings yourself, for example with `conversation.ui.theme.fg(...)`.

### Autocomplete Providers

Use `conversation.ui.addAutocompleteProvider()` to stack custom autocomplete logic on top of the built-in slash-command and path provider. Set `triggerCharacters` for custom natural triggers such as `$`.

Typical pattern:

- inspect the text before the cursor
- return your own suggestions when your extension-specific syntax matches
- otherwise delegate to `current.getSuggestions(...)`
- delegate `applyCompletion(...)` unless you need custom insertion behavior

```typescript
steward.on("session_start", (_event, { conversation }) => {
  conversation.ui.addAutocompleteProvider((current) => ({
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

For complex UI, use `conversation.ui.custom()`. This temporarily replaces the editor with your component until `done()` is called:

```typescript
import { Text, Component } from "@opsyhq/tui";

const result = await conversation.ui.custom<boolean>((tui, theme, keybindings, done) => {
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
import { CustomEditor, type ExtensionAPI } from "@opsyhq/steward";
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

export default function (steward: ExtensionAPI) {
  steward.on("session_start", (_event, { conversation }) => {
    conversation.ui.setEditorComponent((_tui, theme, keybindings) =>
      new VimEditor(theme, keybindings)
    );
  });
}
```

**Key points:**
- Extend `CustomEditor` (not base `Editor`) to get app keybindings (escape to abort, ctrl+d, model switching)
- Call `super.handleInput(data)` for keys you don't handle
- Factory receives `theme` and `keybindings` from the app
- Use `conversation.ui.getEditorComponent()` before `setEditorComponent()` to wrap the previously configured custom editor
- Pass `undefined` to restore default: `conversation.ui.setEditorComponent(undefined)`

To compose with another extension that already replaced the editor, capture the previous factory before setting yours:

```typescript
const previous = conversation.ui.getEditorComponent();
conversation.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

### Message Rendering

Register a custom renderer for messages with your `customType`:

```typescript
import { Text } from "@opsyhq/tui";

steward.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, 0, 0);
});
```

Messages are sent via `conversation.sendMessage()`:

```typescript
conversation.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

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
import { highlightCode, getLanguageFromPath } from "@opsyhq/steward";

// Highlight code with explicit language
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// Auto-detect language from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

## Error Handling

- Extension errors are logged, agent continues
- `tool_call` errors block the tool (fail-safe)
- Tool `execute` errors must be signaled by throwing; the thrown error is caught, reported to the LLM with `isError: true`, and execution continues

## Mode Behavior

| Mode | `conversation.mode` | `conversation.hasUI` | Notes |
|------|---------------------|----------------------|-------|
| Interactive | `"tui"` | `true` | Full TUI with terminal rendering |
| Print (`-p`) | `"print"` | `false` | Extensions run but can't prompt |

Use `conversation.mode === "tui"` before TUI-specific features (`custom()`, component factories, terminal input). Use `conversation.hasUI` before dialog and notification methods.
