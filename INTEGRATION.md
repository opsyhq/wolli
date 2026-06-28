# Integration

An Wolli agent is not a chat session. It is a durable worker that can be reached
from many places, run in the background, and speak to a human when needed.

This doc is about the boundary between **integrations** and **extensions**.

## The Split

**Integrations make sounds.**

An integration is a platform-owned connection to the outside world:

- GitHub webhooks
- Telegram
- email
- WhatsApp
- schedules
- generic HTTP webhooks
- agent-to-agent messages

It faces the network, holds credentials, authenticates inbound traffic, and
turns outside activity into visible events. A GitHub webhook arrives. A Telegram
message arrives. The clock ticks. The integration makes that sound available.

It does not decide what the agent should care about.

**Extensions listen.**

An extension is agent-owned behavior. It decides which sounds matter and what to
do with them.

Examples:

- listen to GitHub comments in this repo
- ignore GitHub comments unless they mention the agent
- listen to this Telegram chat
- pipe Telegram messages into a Wolli chat session
- turn a production alert webhook into a headless agent run
- send the agent's reply back through Telegram or GitHub

So integrations are not special workflow objects. They are transports. The
workflow lives in extensions, like everything else the agent learns or builds.

## Flow

```
outside system
  -> integration makes a sound
  -> extension listener matches or ignores it
  -> matched sound becomes an agent event
  -> event enters a session
```

The session can be either:

- **headless**: no human is present; the agent wakes, acts, records, sleeps
- **user-facing**: a human is present through CLI, TUI, web, Telegram, email,
  GitHub, etc.

The important point: an integration does not mean "open a chat." It means
"something happened." The extension decides whether that becomes background work,
a user message, both, or nothing.

## GitHub

The GitHub integration receives webhooks and emits sounds:

- issue comment created
- PR opened
- check failed

A GitHub extension decides what to listen to:

- this repo only
- comments mentioning `@agent`
- failed checks on protected branches

The result might be a headless run that fixes CI, a reply on GitHub, or a user
session asking for approval.

## Telegram

The Telegram integration receives messages and emits sounds.

A Telegram extension can map a Telegram chat to a Wolli user session:

```
Telegram message
  -> Telegram sound
  -> extension maps it into Wolli chat
  -> agent replies in Wolli chat
  -> extension sends reply back to Telegram
```

That is bidirectional chat: the integration carries messages both ways, but the
extension owns the mapping between the external thread and the Wolli session.

## Headless vs User Sessions

We should keep these distinct.

**Headless session**

- started by an integration, schedule, or agent
- no human participant is assumed
- used for background work
- may finish silently
- may send messages if allowed

**User session**

- has a human participant
- has a reply surface, such as TUI, web, Telegram, email, or GitHub
- records the conversation with that human

## Open Questions

- What is the smallest durable listener declaration an extension can register?
- Are unmatched sounds stored, dropped, or only logged operationally?
- Is one external chat thread always one Wolli user session?
- Which outbound replies require approval?
- Can an agent author new integrations, or only extensions over shipped ones?
