# Introduction

How a wolli agent is laid out as files, what runs when a message arrives, and the capabilities you add as it grows.

wolli runs durable personal agents as always-on daemons; each agent is a home directory of ordinary files that you and the agent both edit.

Instead of one large configuration object, each capability gets a clear home. Identity lives in one file, workflows in one folder, integrations in another. wolli discovers that structure and turns it into an agent that remembers across sessions, reacts to events, and keeps working while your machine is on. Clients (the CLI, the TUI) attach to the daemon over HTTP.

## An agent home at a glance

Every agent lives under `~/.wolli/agents/<name>/`:

```
~/.wolli/agents/<name>/
├── SOUL.md
├── MEMORY.md
├── agent.json
├── integrations/
│   └── telegram.ts
├── workflows/
│   └── telegram-chat.ts
├── hooks/
├── tools/
├── providers/
├── skills/
├── prompts/
├── themes/
└── sessions/
```

You can read most of an agent from that tree:

- `SOUL.md` and `MEMORY.md` hold identity and durable notes; the agent maintains both.
- `agent.json` holds runtime configuration.
- [integrations/](./integrations.md) connect external services (Telegram, a scheduler); transport only.
- [workflows/](./workflows.md) route events into sessions and automate everything else.
- [hooks/](./hooks.md) intercept engine events: block tool calls, rewrite input.
- [tools/](./tools.md) hold typed functions loaded into session tooling.
- [providers/](./providers.md) add model providers.
- [skills/](./skills.md) hold procedures the model loads when they apply.
- `prompts/` holds `/name` text macros, and `themes/` holds TUI color schemes.
- `sessions/` is the agent's lifetime conversation record.

A new agent needs none of the capability folders. wolli writes `SOUL.md` with you in the first conversation; add the rest when the agent needs them.

## The files are the interface

Identity comes from the path. A workflow's name is its export binding — a `default` export takes the filename — and a file may hold several. This file defines a workflow named `inbound`:

```ts
// ~/.wolli/agents/assistant/workflows/telegram-chat.ts
import telegram from "../integrations/telegram";

// msg is typed from the event schema
export const inbound = telegram.on("message", async (msg, ctx) => {
  const [match] = await ctx.agent.findSessions({ "telegram:chat": String(msg.chatId) });
  const session = await ctx.agent.openSession(match.id); // create-if-missing elided
  await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
});
```

There is no registry to keep in sync. Add the file and wolli discovers it; run `/reload` to apply the change without restarting the daemon. See [Workflows](./workflows.md) for the complete API.

## What happens when a message arrives

A Telegram message lands in the integration's transport loop, which emits a typed `message` event. A workflow bound to that event finds the chat's session by tag, or creates one, and sends the text in. The agent runs the turn, calling tools as it works. When the turn ends, a second workflow fires on `agent_end`, reads the chat tag off the session, and delivers the reply through the integration.

The session does not know which platform asked. Replies ride the session's tags, so a turn the scheduler triggers in a Telegram-tagged session still returns to that chat.

## Sessions are durable

A session is an append-only JSONL tree, the lifetime record of one conversation. Nothing is rewritten; wolli reconstructs context deterministically from the log, and the latest leaf resumes by default. The daemon restarts, the machine reboots, and every conversation survives.

Workflow activity is recorded the same way. Each trigger firing creates a run, and everything the handler does through its context lands in that run as a step, so you can inspect what fired and what it did.

## Grow the agent by adding capabilities

As the agent grows, each concern keeps a predictable home:

| Path | Add it when you need... |
| --- | --- |
| [providers/](./providers.md) | A model provider wolli does not ship |
| [skills/](./skills.md) | Procedures the model loads on demand |
| `prompts/` | Reusable `/name` text macros |
| `themes/` | A custom TUI color scheme |
| `store/` | Durable key-value state an integration owns |

The home is plain files, so the agent can author them itself; an agent that needs a new workflow writes one into its own folder. The directory stays readable before it runs.

## What to read next

- [Workflows](./workflows.md): triggers, routing, and the run and step record.
- [Integrations](./integrations.md): transports, typed events, and actions.
- [Tools](./tools.md): typed functions the model calls.
- [Plugins](./plugins.md): package and install capabilities.
