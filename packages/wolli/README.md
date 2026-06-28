# @opsyhq/wolli

Wolli is a persistent, purposeful agent that runs in your terminal. Unlike a
chat session, a Wolli agent is created *for* something — a purpose stated by
its human at birth — and that purpose becomes the organizing principle for its
life. It remembers across conversations, curates its own memory, and works
toward its purpose until you retire it.

```
$ wolli new calories
agent: What is my purpose?
you:   Help me count calories and lose weight.
```

That answer becomes the agent's purpose. It doesn't reset between
conversations. The agent maintains its own curated memory, picks up where it
left off, and grows more specialized over time.

## Quick start

Install with npm:

```bash
npm install -g @opsyhq/wolli
```

Wolli reuses credentials that another agent CLI may have already set up under
`~/.wolli/agent/` (API keys and OAuth tokens). To set a key explicitly, export
it before starting:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Create your first agent and start its birth conversation:

```bash
wolli new calories
```

The agent opens by asking what it's for. Answer conversationally — it
interviews you, records what it learns, and distills its own purpose. When you
both agree it understands its job, it deploys and begins working.

## Lifecycle: forming → deploy

Every agent has two phases:

- **Forming.** A newly created agent is *not yet deployed*. Its only job is to
  understand its purpose and its human. It interviews you one question at a
  time, recording facts about you (`USER.md`) and its own durable notes
  (`MEMORY.md`). It does not act unattended and does not start doing the job —
  first it becomes itself.
- **Deployed.** When the two of you agree the agent understands its purpose, it
  calls the `deploy` tool with its distilled purpose and a final `SOUL.md` (who
  it is, what it's for, how it operates). You confirm, and the agent is
  deployed. You can also type `/deploy` to start that yourself.

Deployment is the single human-held latch: until an agent is deployed it
maintains its own files but may not act on its own.

## CLI

```
wolli new <name> [--model provider/id]      Create an agent, then start its birth conversation
wolli list                                  List agents
wolli delete <name>                          Delete an agent (type-the-name confirm)
wolli <name> [message] [--new] [--print]    Talk to an agent
```

Options:

| Flag | Description |
|------|-------------|
| `--model <provider/id>` | Model to use (e.g. `anthropic/claude-opus-4-8`) |
| `--provider <provider>` | Provider override |
| `--thinking <level>` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `--new` | Start a fresh session instead of resuming the latest |
| `--print`, `-p` | Single-shot print mode |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## Interactive mode

Running `wolli <name>` drops you into an interactive terminal UI (TUI). By
default it resumes the agent's latest session so you continue where you left
off; pass `--new` to start a fresh session.

In the editor you can:

- Type a message and press Enter to talk to the agent.
- Use `/` commands (prompt templates and skills register as slash commands).
- Run a shell command inline by prefixing it with `!`.
- Type `/deploy` to deploy a forming agent.

For one-shot, non-interactive use, pass a message and `--print`:

```bash
wolli calories "log: two eggs and toast" --print
```

## Sessions

Sessions are an append-only record tree — the agent's lifetime memory. Nothing
is rewritten; context is reconstructed deterministically from the record. An
agent's history, decisions, and work survive restarts.

Each agent stores its sessions under its own home (see
[Agent homes](#agent-homes)). When you start an agent without `--new`, Wolli
resumes the latest leaf of its session tree and renders the resumed transcript
so you have the full context in front of you.

## Context and system prompt

The agent's system prompt is built from its identity (name + purpose) plus a
frozen snapshot of its curated memory, read once at session start:

- **`SOUL.md`** — who the agent is, what it's for, how it operates. Written at
  deploy time and revised deliberately.
- **`MEMORY.md`** — the agent's durable notes about its work and the world.
- **`USER.md`** — facts the agent has learned about its human.

These files are read once and frozen into the prompt for the whole session,
which keeps the prompt byte-identical across turns and the prefix cache warm.
Edits made mid-session (via the memory tool or file tools) persist to disk but
only enter the prompt the next session. The agent edits its own memory with the
`memory` tool.

## Customization

Each agent can be extended with prompt templates, skills, extensions, and
themes. These live under the per-agent home so an agent's customizations belong
to it (see [Agent homes](#agent-homes)).

- **[Prompt templates](docs/prompt-templates.md)** — reusable Markdown prompts
  that expand from `/name` slash commands, with positional arguments.
- **[Skills](docs/skills.md)** — self-contained capability packages the agent
  loads on demand (Agent Skills standard).
- **[Extensions](docs/extensions.md)** — TypeScript modules that add tools,
  commands, event handlers, and custom UI.
- **[Themes](docs/themes.md)** — JSON color themes for the TUI.

See [docs/](docs/index.md) for the full documentation index and
[examples/](examples/) for working extension and SDK examples.

## Agent homes

Wolli keeps each agent's state in its own home directory so deleting an agent
also cleans up everything attached to it.

| Path | Contents |
|------|----------|
| `~/.wolli/agents/<name>/` | Per-agent home |
| `~/.wolli/agents/<name>/agent.json` | Identity config (name, purpose, deploy state) |
| `~/.wolli/agents/<name>/SOUL.md` | Curated identity |
| `~/.wolli/agents/<name>/MEMORY.md` | Curated durable memory |
| `~/.wolli/agents/<name>/USER.md` | Curated facts about the human |
| `~/.wolli/agents/<name>/sessions/` | Append-only session tree |
| `~/.wolli/agents/<name>/workspace/` | The agent's owned working directory |
| `~/.wolli/agents/<name>/{extensions,skills,prompts,themes}/` | Per-agent customizations |
| `~/.wolli/agent/` | Shared credentials (`auth.json`) and default model settings |

Override the root with `WOLLI_HOME` (defaults to `~/.wolli`).

## SDK usage

Wolli exposes its agent builder programmatically from `@opsyhq/wolli`. The
SDK builds the engine's high-level `AgentHarness` from an execution environment,
a session, a model, and a pre-built system prompt (`openAgentSession`,
`loadMemory`, `buildSystemPrompt`, `AuthStorage`, `createAgentSession`).

`AuthStorage` resolves a provider key from the shared credential store
(`~/.wolli/agent/auth.json`) populated by `/login`, then OAuth tokens, then
environment variables — so an existing login or an `ANTHROPIC_API_KEY` both work
with no extra setup.

See [docs/sdk.md](docs/sdk.md) for the full walkthrough.

## License

Apache-2.0
