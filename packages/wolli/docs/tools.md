# Tools

Typed actions the model calls, authored as one file per tool under `tools/`.

A tool is a typed action the model can call during a turn (an HTTP request, a conversion, a query against a service you run). Authored tools run in the daemon process alongside the built-in suite: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, and `memory`. The built-ins route file and shell work through the agent's sandboxed environments; author a tool when the model needs an action that lives outside them. wolli loads every file under `tools/` into session tooling at startup. There is no mid-session registration.

## Define a tool

One file defines one tool, default-exporting `defineTool`:

`~/.wolli/agents/assistant/tools/http_get.ts`

```ts
import { defineTool } from "wolli";
import { Type } from "typebox";

export default defineTool({
  name: "http_get",
  label: "HTTP GET",
  description:
    "Fetch a URL over HTTP GET and return the status line and body. Bodies over 50KB are truncated.",
  promptSnippet: "Fetch a URL over HTTP GET",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute http(s) URL" }),
  }),
  async execute(toolCallId, { url }, signal) {
    const response = await fetch(url, { signal });
    const body = (await response.text()).slice(0, 50_000);
    return {
      content: [{ type: "text", text: `${response.status} ${response.statusText}\n\n${body}` }],
      details: { status: response.status },
    };
  },
});
```

The `name` field is the identifier the model uses in tool calls; keep it matched to the filename. `label` is the human-readable name clients display for the running call. wolli evaluates the file at runtime; there is no build step.

## What the model sees

The model decides whether and how to call a tool from the definition's prompt-facing fields. `description` is the contract: state what the tool does, what it returns, and its limits, written for the model. `promptSnippet` is a one-line entry in the Available tools section of the default system prompt; a tool without one stays callable but is not advertised there. `promptGuidelines` appends bullets to the system prompt's Guidelines section while the tool is active, the place for usage rules ("Prefer `http_get` over `bash` with curl.").

`parameters` is a TypeBox schema. wolli validates every call's arguments against it before `execute` runs, and per-property `description` strings reach the model, so constraints belong in the schema rather than in prose.

## The `execute` function

wolli calls `execute` in the daemon once the arguments pass validation. `toolCallId` identifies this call; the same id marks the call in the session record. `params` arrives typed from the `parameters` schema. `signal` fires when the turn is aborted; pass it to cancellation-aware work, as the example does with `fetch`.

Long-running tools stream progress through `onUpdate`, which accepts the same shape as the return value:

```ts
onUpdate?.({ content: [{ type: "text", text: `fetched ${done} of ${total} pages` }], details: { done } });
```

Clients render each partial result in place while the call runs. Both `signal` and `onUpdate` are optional to handle; a short tool can ignore them. The fifth argument, `ctx`, is the session facade for the session that made the call.

The return value carries `content`, the text or image parts the model reads, and `details`, structured data for logs and client rendering that stays out of model context. Throw an `Error` on failure instead of encoding it in `content`.

## Execution

Tool calls run as steps of the turn. Every call is recorded with its `toolCallId` as a child step under the `session.prompt` step that produced it, so a routed conversation shows exactly which tools each turn used. See [Workflows](./workflows.md) for the run tree these steps land in.

`executionMode` controls concurrency within a batch of calls. Set `"sequential"` when a tool must not overlap other tool calls (it mutates shared state, say), or `"parallel"` when overlapping is safe; omitted, the session default applies.

Do not return secrets, credentials, or unbounded output from a tool. Everything in `content` enters the model's context and persists in the session record; filter, bound, and redact results before returning them, the way the example caps the body at 50KB.

## Tool, skill, or workflow

| Need | Use |
| --- | --- |
| A typed action the model invokes mid-turn (an API call, a query) | A tool |
| A procedure or reference the model reads and follows | A [skill](./skills.md) |
| Code that fires on events and routes work into sessions | A [workflow](./workflows.md) |

A tool extends what the model can do, a skill extends what it knows, and a workflow runs without being asked. Prefer a skill when prose over the built-in suite covers the job; author a tool only when the model needs a new typed action.

## What to read next

- [Workflows](./workflows.md): event-triggered routing code and the run tree tool calls nest under
- [Skills](./skills.md): markdown capability documents the model loads when relevant
- [Integrations](./integrations.md): transports that connect the agent to outside services
