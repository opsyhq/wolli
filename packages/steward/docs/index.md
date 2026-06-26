# Steward Documentation

Steward is a persistent, purposeful agent that runs in your terminal. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, integrations, and plugins.

## Quick start

Install Steward with npm:

```bash
npm install -g @opsyhq/steward
```

Then birth a new agent and start its birth conversation:

```bash
steward new <name>
```

The agent opens by asking what it is for. Answer conversationally; it interviews you, distills its purpose, and when you both agree it understands its job, deploy it (it offers to, or type `/deploy`). Reconnect to a deployed agent any time with `steward <name>`.

Authenticate with `/login` for subscription/OAuth providers (Claude and others), or set an API key such as `ANTHROPIC_API_KEY` before starting steward. Credentials persist to the shared `~/.steward/agent/auth.json` and are reused by every agent.

For the full first-run flow, CLI reference, sessions, and the agent-home layout, see the [package README](../README.md).

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Integrations](integrations.md) - connect external services and message channels to the agent.
- [Plugins](plugins.md) - bundle, publish, and install extensions, integrations, skills, prompts, and themes.

## Programmatic usage

- [SDK](sdk.md) - embed steward in Node.js applications.
