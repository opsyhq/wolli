# Mission

Wolli builds persistent, purposeful AI agents.

An Wolli agent is not a chat session. It is a durable worker with a purpose, memory, tools, workspace, and the ability to act proactively on behalf of a human or organization.

The agent begins by asking: **What is my purpose?**

That purpose becomes the organizing principle for the agent's life. It shapes what the agent remembers, what tools it creates or uses, when it speaks up, how it behaves, and how it improves over time.

## Core Beliefs

1. **Agents should begin with purpose.**
   An agent should be created for something specific, stated by its human at birth.

2. **Purpose should shape behavior.**
   Memory, tools, workflows, schedules, and proactive actions should all be organized around the agent's purpose.

3. **Agents should persist.**
   An agent's life should be measured in months or years, not individual chat sessions. Its history, decisions, configuration, and work should survive restarts and migrations.

4. **Agents should own their workspace.**
   Each agent should have its own home, storage, hooks, tools, and configuration. Deleting an agent should also clean up the operational footprint attached to it.

5. **Agents should be extensible.**
   We cannot pre-build every integration or workflow. The system should let agents and users create, install, configure, and evolve extensions as new needs appear.

6. **Agents should be proactive.**
   A purposeful agent should not only respond to prompts. It should be able to follow up, run on schedules, react to events, and act when its purpose requires attention.

7. **Users should own their data.**
   Users should be able to inspect, export, and move their agents. The open-source runtime should provide an escape hatch and a foundation for trust.

8. **Local runtime and cloud platform serve different roles.**
   Local execution gives ownership, transparency, and extensibility. Hosted infrastructure provides durability, always-on execution, cloud storage, versioning, email identity, scheduled jobs, monitoring, and managed sandboxes.

## Product Direction

Wolli should make it easy to create agents that become more specialized and useful over time.

Examples:

- A calorie-tracking agent should remember the user's goals, learn their habits, and proactively ask what they ate if they miss a day.
- A project SRE agent should own monitoring, alerts, logs, runbooks, and fixes for the project it was created to protect.
- A coding agent should not only edit files, but accumulate durable context, tools, and workflows around the codebase it serves.

The interface is secondary. An agent may be reached through CLI, TUI, web, mobile, email, Discord, Telegram, WhatsApp, or other surfaces. The durable agent is the primary object.

## Engineering Implications

- Treat agent state as durable and recoverable.
- Prefer append-only history and deterministic reconstruction over hidden mutable state.
- Design for local/cloud portability from the beginning.
- Keep agent work inside agent-owned workspaces.
- Make integrations pluggable instead of hardcoding every workflow.
- Preserve user control, inspection, export, and deletion.
- Build proactive/background behavior as a first-class capability.
- Avoid designs that turn agents back into disposable chat sessions.

## Thesis

Agents should not just do tasks.

They should find and fulfill a role.
