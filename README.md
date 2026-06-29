<div align="center">

# Wolli

**Create purposeful, self-extending AI agents.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/wolli.svg)](https://www.npmjs.com/package/wolli)
[![CI](https://github.com/opsyhq/wolli/actions/workflows/ci.yml/badge.svg)](https://github.com/opsyhq/wolli/actions/workflows/ci.yml)

[Install](#install) · [How it works](#how-it-works) · [Roadmap](ROADMAP.md)

</div>

---

> **What is my purpose?**

Wolli lets you create purposeful agents. That purpose becomes the organizing
principle of an agent's life: it remembers across sessions, runs on a schedule,
acts on events, and extends itself to do its job better over time, writing its
own skills, integrations, and extensions as the work demands.

## Install

```sh
npm install -g wolli
wolli
```

The first run sets up your provider and creates your first agent. A new agent
starts in a **forming** state: it interviews you to work out its purpose and
records what it learns, and does not act unattended until you deploy it. Agents and
state live under `~/.wolli`. `●` deployed and `○` forming.

```
 Agents

 → ● inbox    Triage my email each morning, draft replies to the routine ones, flag what needs me.
   ● scout    Watch the repos and deps we ship; when a release or CVE needs action, open an issue and ping me.
   ● ledger   Track project spend across providers, reconcile invoices weekly, warn me before a budget tips over.
   ○ sprout   Still working out my purpose.

 ↑/↓ browse · enter chat · tab details · type to search commands · ctrl+c quit
```

## How it works

- **Purpose-built.** You state the agent's purpose at birth. It decides what the
  agent stores, when it speaks up, and what it does unattended.
- **Self-extending.** The agent builds itself out for its purpose. It curates its
  own memory and authors and installs its own skills, tools, extensions and integrations; they
  live in its home and load on reload. The agent grows more capable at its job
  instead of staying a fixed tool.
- **Persistent.** Sessions are an append-only JSONL tree, the agent's lifetime
  memory. Nothing is rewritten; context is reconstructed deterministically and the
  latest leaf resumes by default.
- **Curated memory.** Three files are read once and frozen into the system prompt
  per session, and the agent maintains them through a memory tool:

  | File | Holds |
  | --- | --- |
  | `SOUL.md` | Identity, authored at deploy. |
  | `MEMORY.md` | Durable notes the agent keeps. |
  | `USER.md` | Facts about its human. |

- **Always on, locally.** A per-agent daemon supervised by launchd (macOS) or
  systemd (Linux) runs the agent on schedules and events while your machine is on.
- **Sandboxed.** The agent runs in a sandbox by default: `srt` (Apple Seatbelt /
  bubblewrap), or optional Docker. Reaching your real machine is an explicit,
  approval-gated escalation.
- **Any model.** Multi-provider via OAuth `/login` (Anthropic, OpenAI, and others).

## Lifecycle

| State | What happens |
| --- | --- |
| **forming** | Interviews its human and records memory. Does not act unattended. |
| **deployed** | The agent has authored its purpose and `SOUL.md`, and you confirmed `/deploy`, the single human-held latch. It now runs on schedules and events. |

`wolli delete <name>` removes an agent and its state.

## Extending an agent

An agent's capabilities are plugins under its own home, so deleting the agent
removes them with it:

| Type | What it adds |
| --- | --- |
| **Integrations** | TypeScript modules: tools, commands, events, UI. |
| **Extensions** | TypeScript modules: tools, commands, events, UI. |
| **Skills** | The Agent Skills standard. |
| **Prompt templates** | `/name` slash commands. |
| **Themes** | TUI appearance. |

Two integrations ship bundled: **Telegram** (bidirectional chat) and a
**scheduler** (cron). Manage plugins with `wolli <agent> plugins ...`.

## CLI

| Command | Action |
| --- | --- |
| `wolli` | Set up on first run; otherwise pick an agent and open it |
| `wolli new <name>` | Create and birth a new agent |
| `wolli <agent>` | Open a specific agent interactively |
| `wolli <agent> "msg" --print` | One-shot, non-interactive reply |
| `wolli list` | List agents |
| `wolli restart <name>` | Restart an agent's daemon |
| `wolli delete <name>` | Remove an agent and its state |
| `wolli <agent> plugins ...` | Manage an agent's plugins |

## Documentation

Full documentation is in [`packages/wolli/docs`](packages/wolli/docs/index.md):
extensions, skills, prompt templates, themes, integrations, plugins, and the SDK.

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
