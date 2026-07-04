# Getting Started

Wolli is a persistent, purposeful agent that runs in your terminal. It stays small at the core while growing through integrations, workflows, tools, providers, skills, prompt templates, themes, and plugins. Start with the [Introduction](introduction.md) for how those fit together.

## Quick start

Install Wolli with npm:

```bash
npm install -g wolli
```

Then create a new agent and start its first conversation:

```bash
wolli new <name>
```

The agent opens by asking what it is for. Answer conversationally; it interviews you, distills its purpose, and when you both agree it understands its job, it writes its own SOUL.md. Reconnect any time with `wolli <name>`.

Authenticate with `/login` for subscription/OAuth providers (Claude and others), or set an API key such as `ANTHROPIC_API_KEY` before starting wolli. Credentials persist to the shared `~/.wolli/agent/auth.json` and are reused by every agent.

For the full first-run flow, CLI reference, sessions, and the agent-home layout, see the [package README](../README.md).

## Customization

- [Integrations](integrations.md) - transports that connect external services and message channels to the agent.
- [Workflows](workflows.md) - route events into sessions and automate the agent.
- [Tools](tools.md) - typed actions the model calls during a turn.
- [Providers](providers.md) - model providers beyond the built-in catalog.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Plugins](plugins.md) - bundle, publish, and install any mix of those resources.

## Programmatic usage

- [SDK](sdk.md) - embed wolli in Node.js applications.
