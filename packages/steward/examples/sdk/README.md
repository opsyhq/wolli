# SDK Examples

Programmatic usage of Steward via `openAgentSession()` and `createAgentSession()`.

`openAgentSession(name)` opens (or resumes) an agent's durable, per-agent session
and returns the execution env, session, repo, and workspace cwd. `createAgentSession()`
builds an `AgentHarness` from a model, a pre-built system prompt, and a tool set.
You drive the harness with `harness.prompt()` and observe it with `harness.subscribe()`.

Steward is agent-centric: each example talks to a named agent. Create one first:

```bash
steward new assistant
```

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Build a harness and stream one reply |
| `02-custom-model.ts` | Select a model and thinking level |
| `05-tools.ts` | Choose the built-in tool set |
| `09-api-keys-and-oauth.ts` | Credential resolution via AuthStorage |
| `10-settings.ts` | Read and override settings with SettingsManager |
| `11-sessions.ts` | Resume, start fresh, and list sessions |

## Running

```bash
cd packages/steward
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession } from "@opsyhq/steward";

// Auth and models.
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const [model] = modelRegistry.getAvailable();

// Open (or resume) the agent's session and execution env.
const { env, session } = await openAgentSession("assistant");

// Build the harness.
const { harness } = await createAgentSession({
  env,
  session,
  model,
  systemPrompt: "You are a helpful assistant.",
  authStorage,
});

// Stream and run.
harness.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await harness.prompt("Hello");
```

## `createAgentSession` options

| Option | Default | Description |
|--------|---------|-------------|
| `env` | — | Execution env (from `openAgentSession`) |
| `session` | — | Durable session (from `openAgentSession`) |
| `model` | — | Model to use (from `ModelRegistry`) |
| `systemPrompt` | — | Pre-built prompt, frozen for the session's lifetime |
| `tools` | `undefined` | Built-in tool factories, e.g. `createReadTool(cwd)` |
| `thinkingLevel` | `DEFAULT_THINKING_LEVEL` | off, minimal, low, medium, high, xhigh |
| `resources` | `undefined` | Skills + prompt templates for explicit invocation |
| `authStorage` | `AuthStorage.create()` | Credential store for API key resolution |

For the full agent runtime — extensions, skills, prompt templates, and in-place
session swaps — use `SessionHost` (see `src/main.ts`), which composes
`openAgentSession` + `createAgentSession` and builds the system prompt from the
agent's identity and curated memory.

## Events

```typescript
harness.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```
