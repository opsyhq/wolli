# Workflows

Route events into sessions and automate the agent from `workflows/`.

A workflow is a typed reaction to an event, or a callable operation, authored as one file under `~/.wolli/agents/<name>/workflows/`. One file, one workflow; the filename is the name, the default export the definition. Each firing of the trigger is a run, and everything the handler does through `ctx` is recorded as steps. Keep module scope free of state; wolli may reload the file at any time.

The inbound half of a chat channel is one workflow that binds each chat to its own session by tag:

`~/.wolli/agents/assistant/workflows/telegram-inbound.ts`

```ts
import { defineWorkflow } from "wolli";
import telegram from "../integrations/telegram";

export default defineWorkflow({
  on: telegram.events.message, // msg is typed from the event schema
  async run(msg, ctx) {
    const chatTag = { "telegram:chat": String(msg.chatId) };
    const [match] = await ctx.agent.findSessions(chatTag);
    const session = match
      ? await ctx.agent.openSession(match.id)
      : await ctx.agent.createSession({
          setup: (s) => s.appendTags(chatTag),
        });
    // followUp queues behind a running turn instead of interrupting it.
    await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
  },
});
```

Two chats run in parallel because each holds its own tagged session, and any workflow can locate that session later with the same tag query.

## Triggers

A workflow declares its trigger on the single config object passed to `defineWorkflow`. There are three kinds.

An integration event: import the integration and bind one of its typed event descriptors, as `telegram-inbound.ts` does with `on: telegram.events.message`. The descriptor is inert data; it carries the payload type, so `msg` arrives typed and validated.

An agent lifecycle event: a string literal, no import needed.

`workflows/turn-metrics.ts`

```ts
import { defineWorkflow } from "wolli";

export default defineWorkflow({
  on: "turn_end", // evt is typed via AgentEventMap
  async run(evt, ctx) {
    console.log(`turn ${evt.turnIndex} ran ${evt.toolResults.length} tools`);
  },
});
```

A callable: omit `on` and declare `input` and `output` TypeBox schemas instead. The agent invokes a callable workflow by name.

`workflows/fetch-page.ts`

```ts
import { defineWorkflow } from "wolli";
import { Type } from "typebox";

export default defineWorkflow({
  input: Type.Object({ url: Type.String() }),
  output: Type.Object({ excerpt: Type.String() }),
  async run(input) {
    const res = await fetch(input.url);
    return { excerpt: (await res.text()).slice(0, 500) };
  },
});
```

### Lifecycle events

This is the complete set. Handlers are observe-only; a workflow watches these events and cannot modify them.

| Event | Fires when |
| --- | --- |
| `session_start` | a session starts, loads, or reloads |
| `session_shutdown` | a session is torn down on quit, reload, or replacement |
| `agent_start` | an agent loop begins processing a prompt |
| `agent_end` | the loop finishes, with the turn's messages |
| `turn_start` | a turn inside the loop begins |
| `turn_end` | a turn ends, with the assistant message and tool results |
| `message_start` | a user, assistant, or tool-result message begins |
| `message_update` | an assistant message streams a token update |
| `message_end` | a message completes |
| `tool_execution_start` | a tool call starts |
| `tool_execution_update` | a tool call reports partial output |
| `tool_execution_end` | a tool call finishes, with its result |
| `model_select` | the session switches models |
| `thinking_level_select` | the session changes thinking level |

## The handler and ctx

`run(event, ctx)` receives the trigger payload and a context scoped to the run. `telegram-inbound.ts` already used `ctx.agent`, the this-agent surface: `findSessions(tags)` subset-matches session tags newest first, `openSession(id)` rehydrates a stored session, `createSession(opts)` starts a fresh one, `listSessions()` enumerates them, and `cwd` is the agent home path. Lifecycle-triggered runs also carry the session that produced the event:

`workflows/greet-new-session.ts`

```ts
import { defineWorkflow } from "wolli";
import telegram from "../integrations/telegram";

export default defineWorkflow({
  on: "session_start",
  async run(evt, ctx) {
    const chat = ctx.session.getTags()["telegram:chat"]; // the producing session
    if (!chat || evt.reason !== "new") return;
    const text = await ctx.step("compose-greeting", () => "Fresh session ready.");
    await ctx.integration(telegram).sendMessage({ chatId: Number(chat), text });
  },
});
```

`ctx.integration(telegram)` takes the imported definition as a typed key and returns a flat action handle; parameters are validated on every call. Pass an account id for a second account, `ctx.integration(telegram, "work")`; the default is `"default"`. `ctx.step(name, fn)` wraps inline logic in a named, recorded step. `ctx.signal` is the run's `AbortSignal`; pass it to anything long-running.

`ctx.session` exists only on lifecycle-triggered runs, as the facade of the producing session (`prompt`, `sendUserMessage`, `getTags`, `setTags`). Integration-event and callable runs have no producing session, so the field is absent. The same rule gates `ctx.ui`, four dialog primitives (`select`, `confirm`, `input`, `notify`) available only when `ctx.session` exists. Everywhere else the run is headless; a workflow that needs an answer from a user asks through its channel.

## Runs and steps

Each trigger firing creates a run named after the workflow, and every call through `ctx` lands in it as a step: `ctx.agent.*` calls, integration actions, `ctx.step` blocks, and session deliveries. `session.prompt` and `session.sendUserMessage` record one step each; what the prompted agent does inside the turn lives in that session's own history, not in the run. A routed chat message and its reply record like this:

```
run: telegram-inbound (telegram:message)
  step: agent.findSessions        (auto)
  step: agent.createSession       (auto)
  step: session.prompt            (auto)
run: telegram-reply (agent_end)
  step: integration.call sendMessage (auto)
```

Step results are data. A step that produces a live object records its identity instead: a session step records the session id, and `ctx` rehydrates the handle when the handler touches it. Keep your own `ctx.step` return values serializable. There is no resume; a run that crashes does not continue, and its record shows how far it got.

## Replies ride the session's tags

The outbound half reads the tag off the producing session, not off the channel:

`~/.wolli/agents/assistant/workflows/telegram-reply.ts`

```ts
import { defineWorkflow } from "wolli";
import telegram from "../integrations/telegram";

export default defineWorkflow({
  on: "agent_end",
  async run(evt, ctx) {
    const chat = ctx.session.getTags()["telegram:chat"];
    if (!chat) return; // not a telegram-bound session
    const text = evt.messages
      .filter((m) => m.role === "assistant")
      .at(-1)
      ?.content.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    if (!text) return; // a pure tool-call turn sends nothing
    await ctx.integration(telegram).sendMessage({ chatId: Number(chat), text });
  },
});
```

Because the reply rides the producing session's tags, the answer returns to the chat that started the turn, not to whoever messaged last. This composes across integrations: when a scheduler `due` event prompts a telegram-tagged session, `agent_end` fires with that session, the tag is present, and the digest lands in the chat. Neither workflow knows the other exists.

Channel commands are inline logic in the inbound workflow, not a registration system:

```ts
// In telegram-inbound.ts, before the session lookup:
if (msg.text.startsWith("/")) return handleCommand(msg, ctx); // /new, /status
```

## Failure

A thrown handler fails the run. wolli records the failure alongside the steps that completed before it, and does not retry. Catch the errors you can act on inside the handler; let the rest fail the run so the record stays honest.

## Workflow vs tool vs skill vs integration

| Need | Use |
| --- | --- |
| React to an event, or route it into a session | a workflow |
| Give the model an action it can call mid-turn | a tool |
| Teach the agent a procedure in prose | a skill |
| Speak a service's protocol (transport, events, actions) | an integration |

Integrations move bytes; workflows decide where they go. When logic could live in either, put the transport in the integration and the decision in a workflow.

## What to read next

- [Integrations](./integrations.md): the transport half, `defineIntegration`, events, and actions.
- [Tools](./tools.md): typed actions loaded into session tooling.
- [Skills](./skills.md): markdown capability documents the agent reads.
