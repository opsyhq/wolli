# Hooks

Intercept engine events and decide what happens next from `hooks/`.

A hook is the one place agent-home code alters engine behavior. Where a [workflow](./workflows.md) observes a lifecycle event and reacts alongside the turn, a hook sits in the turn's path and decides: block a tool call, rewrite input, replace the messages headed to the model. Each hook is one file under `~/.wolli/agents/<name>/hooks/`; the filename is the name, the default export the definition. A hook runs inline in the turn that fires it, so it stays fast and does no durable work.

The simplest hook guards a tool before it runs:

`~/.wolli/agents/assistant/hooks/guard-bash.ts`

```ts
import { defineHook, isToolCallEventType } from "wolli";

export default defineHook({
  before: "tool_call",
  run(event) {
    if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
      return { block: true, reason: "destructive command blocked" };
    }
  },
});
```

`before:` names the event. The handler receives that event and a `ctx`, and returns a decision or nothing. Returning nothing lets the event through untouched, so a hook only acts on the cases it cares about. Add the file and wolli discovers it; run `/reload` to apply a change without restarting the daemon.

## Events

A hook binds exactly one of eight `before:` events. Each one hands the handler the value about to take effect and takes a typed decision back.

| `before:` | The handler sees | Returning |
| --- | --- | --- |
| `tool_call` | the tool about to run (`toolName`, `input`) | mutate `event.input` in place to patch arguments; `{ block, reason }` to stop the call |
| `tool_result` | a finished tool's `content`, `details`, `isError` | any of those keys to rewrite the result |
| `input` | user input before the turn (`text`, `images`, `source`) | `{ action: "transform", text }` to rewrite it, `{ action: "handled" }` to consume it |
| `context` | the `messages` array bound for the model | `{ messages }` to replace it |
| `provider_request` | the raw provider `payload` | a new payload to send instead |
| `agent_start` | the assembled `prompt` and `systemPrompt` | `{ message }` to inject a message, `{ systemPrompt }` to replace the prompt for this turn |
| `compact` | a pending compaction (`preparation`, `branchEntries`) | `{ cancel: true }` to stop it |
| `message_end` | a finalized `message` | `{ message }` to replace it, keeping the same role |

These are the interception counterpart to a workflow's observe-only lifecycle events. A hook cannot bind `on:`, is not callable, and has no input or output schema.

## Chains and short-circuits

Hooks bound to the same event run as a chain in load order: the agent's own `hooks/` files by filename, then any from installed plugins. Each hook sees the event as earlier hooks left it, so patches accumulate down the chain. An `input` hook that rewrites text hands the next hook the rewritten text:

`~/.wolli/agents/assistant/hooks/redact-input.ts`

```ts
import { defineHook } from "wolli";

export default defineHook({
  before: "input",
  run(event) {
    const redacted = event.text.replace(/sk-[a-z0-9]+/gi, "[redacted]");
    if (redacted === event.text) return;
    return { action: "transform", text: redacted };
  },
});
```

A terminal decision short-circuits the rest of the chain: a `tool_call` `{ block }`, a `compact` `{ cancel }`, or an `input` `{ action: "handled" }` stops there and no later hook runs. `tool_call` is the exception that patches by mutation: change `event.input` in place and later hooks and the executor see the change. `agent_start` accumulates every injected message and chains `systemPrompt` replacements, so the last hook to set one wins. A `message_end` replacement must keep the original message role; a role change is rejected and the chain moves on.

## ctx

Every hook event belongs to the session that produced it, so `ctx.session` and `ctx.ui` are always present. `ctx.session` is that session's surface: `prompt`, `sendUserMessage`, `getTags`, `setTags`, and its `id`. `ctx.ui` is the four dialog primitives routed to the session's clients: `select`, `confirm`, `input`, `notify`. A hook can ask before it lets the engine proceed:

`~/.wolli/agents/assistant/hooks/confirm-compact.ts`

```ts
import { defineHook } from "wolli";

export default defineHook({
  before: "compact",
  async run(event, ctx) {
    const ok = await ctx.ui.confirm("Compact now?", "Older messages will be summarized.");
    if (!ok) return { cancel: true };
  },
});
```

Because the dialog rides the producing session's clients, the prompt reaches whoever is attached to that session. A hook on a headless session still runs; its `ctx.ui` calls resolve without a user in front of them.

## Failure

A hook that throws fails open: wolli reports the error and the chain continues with the event as the throwing hook left it. A broken hook cannot break the turn.

## Hooks vs workflows

Both react to engine events, but they answer different questions.

| Need | Use |
| --- | --- |
| Alter an event before it takes effect: block, rewrite, replace | a hook |
| React to an event, or route it into a session | a workflow |

Put the decision in a hook and the reaction in a workflow. A hook blocks a tool call in the live turn; a workflow watching `tool_execution_end` records that the call happened.

## What to read next

- [Workflows](./workflows.md): triggers, routing, and the run and step record.
- [Tools](./tools.md): the typed actions a `tool_call` hook guards.
- [Plugins](./plugins.md): package and install hooks alongside other resources.
