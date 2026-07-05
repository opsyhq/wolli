<div align="center">

# Wolli

**Create agents that grow around a purpose.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/wolli.svg)](https://www.npmjs.com/package/wolli)
[![CI](https://github.com/opsyhq/wolli/actions/workflows/ci.yml/badge.svg)](https://github.com/opsyhq/wolli/actions/workflows/ci.yml)

[Install](#install) · [How it works](#how-it-works) · [Roadmap](ROADMAP.md)

</div>

---

> **What is my purpose?**

Wolli lets you create agents that grow around a purpose. Each agent remembers across sessions, runs on schedules, reacts to events, and extends itself over time by writing the skills, integrations, and workflows it needs to do its job better.

## Install

```sh
npm install -g wolli
wolli
```

The first run sets up your provider and creates your first agent. A new agent
opens by interviewing you to work out its purpose, then writes its own
`SOUL.md` — its first line becomes the agent's description everywhere. Agents
and state live under `~/.wolli`.

```
 Agents

 → inbox    Triage my email each morning, draft replies to the routine ones, flag what needs me.
   scout    Watch the repos and deps we ship; when a release or CVE needs action, open an issue and ping me.
   ledger   Track project spend across providers, reconcile invoices weekly, warn me before a budget tips over.

 ↑/↓ browse · enter chat · tab details · type to search commands · ctrl+c quit
```

## How it works

- **Purpose-built.** The agent works its purpose out with you in its first
  conversation and records it as the first line of its `SOUL.md`. It decides what
  the agent stores, when it speaks up, and what it does unattended.
- **Self-extending.** The agent builds itself out for its purpose. It curates its
  own memory and authors and installs its own skills, tools, workflows, and integrations; they
  live in its home and load on reload. The agent grows more capable at its job
  instead of staying a fixed tool.
- **Persistent.** Sessions are an append-only JSONL tree, the agent's lifetime
  memory. Nothing is rewritten; context is reconstructed deterministically and the
  latest leaf resumes by default.
- **Curated memory.** Three files are read once and frozen into the system prompt
  per session, and the agent maintains them through a memory tool:

  | File | Holds |
  | --- | --- |
  | `SOUL.md` | Identity, authored by the agent; the first line is its purpose. |
  | `MEMORY.md` | Durable notes the agent keeps. |
  | `USER.md` | Facts about its human. |

- **Always on, locally.** A per-agent daemon supervised by launchd (macOS) or
  systemd (Linux) runs the agent on schedules and events while your machine is on.
- **Sandboxed.** The agent runs in a sandbox by default: `srt` (Apple Seatbelt /
  bubblewrap), or optional Docker. Reaching your real machine is an explicit,
  approval-gated escalation.
- **Any model.** Multi-provider via OAuth `/login` (Anthropic, OpenAI, and others).

## Lifecycle

An agent is live from the moment it is created: its daemon is installed as an
OS service at creation and runs on schedules and events from birth. While its
`SOUL.md` is empty it interviews you to work out its purpose, then authors
`SOUL.md` itself.

`wolli delete <name>` removes an agent and its state.

## Extending an agent

An agent's capabilities are plugins under its own home, so deleting the agent
removes them with it:

| Type | What it adds |
| --- | --- |
| **Integrations** | Transports that connect external services and message channels. |
| **Workflows** | Route events into sessions and automate the agent. |
| **Tools** | Typed actions the model calls during a turn. |
| **Providers** | Model providers beyond the built-in catalog. |
| **Skills** | The Agent Skills standard. |
| **Prompt templates** | `/name` slash commands. |
| **Themes** | TUI appearance. |

Two integrations ship bundled: **Telegram** (bidirectional chat) and a
**scheduler** (cron). Manage plugins with `wolli <agent> plugins ...`.

## CLI

| Command | Action |
| --- | --- |
| `wolli` | Set up on first run; otherwise pick an agent and open it |
| `wolli new <name>` | Create a new agent and start chatting with it |
| `wolli <agent>` | Open a specific agent interactively |
| `wolli <agent> "msg" --print` | One-shot, non-interactive reply |
| `wolli list` | List agents |
| `wolli restart <name>` | Restart an agent's daemon |
| `wolli delete <name>` | Remove an agent and its state |
| `wolli <agent> plugins ...` | Manage an agent's plugins |

## Documentation

Full documentation is in [`packages/wolli/docs`](packages/wolli/docs/index.md):
workflows, integrations, tools, providers, hooks, skills, prompt templates, themes, plugins, and the SDK.

## Roadmap

Cloud sync, hosted email identity, agent-to-agent messaging, durable runtimes, and
more inbound integrations are not built yet. Shipped versus planned is tracked in
[ROADMAP.md](ROADMAP.md).

## Contributing

Wolli is a pnpm + TypeScript monorepo (Node >= 22.19).

```sh
pnpm install
pnpm build
pnpm test
```

See [AGENTS.md](AGENTS.md) for development rules before opening a pull request.

## License

[Apache-2.0](LICENSE)
