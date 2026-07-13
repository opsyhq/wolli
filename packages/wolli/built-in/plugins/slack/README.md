# Slack

Connect a wolli agent to Slack over **Socket Mode** — an outbound WebSocket, so no
public URL, TLS certificate, or webhook signing is needed (the app's signing secret
is never used or stored). Setup is a few clicks at api.slack.com plus two token
prompts.

## How the bot behaves

The bot is **mention-gated**: it answers when @-mentioned, then holds a conversation
in the mention's thread.

| Context | Behavior |
|---------|----------|
| **@-mention in a channel** | Starts (or continues) a session bound to that thread and replies in-thread. A mention outside a thread makes that message the thread root. |
| **Replies inside a tracked thread** | Routed to the thread's session as follow-ups — no further mention needed. |
| **Channel chatter outside threads** | Ignored. No mention, no routing. |
| **DMs** | Not routed in v1. |
| **Other bots / itself** | Ignored (loop prevention). |

## Session model

Each mention thread gets its **own wolli session**, bound by a `slack:thread` tag
holding `channelId:threadTs`:

- **Inbound** — a mention or tracked-thread reply routes to the session tagged for its
  thread; a mention in an untracked thread creates and tags one on the spot.
- **Outbound** — the reply rides the producing session's tag, so answers always land
  in the thread that started the turn.

## Events and actions

| Surface | Shape |
|---------|-------|
| `message` event | A user message the bot can see: `{ channelId, ts, threadTs?, text, user: { id }, channelType }`. Edits, deletes, joins, and bot posts (including the bot's own) are dropped. |
| `app_mention` event | The bot was @-mentioned: `{ channelId, ts, threadTs?, text, user: { id } }`. Slack sends a mention as **both** events, and both are emitted — the bundled workflow delivers through `message` and uses `app_mention` only to create sessions, so nothing is double-handled. |
| `sendMessage` action | `{ channelId, text, threadTs? }` → `chat.postMessage`, chunked at 40,000 characters, returns `{ ts: string[] }`. Pass `threadTs` to reply in a thread; Slack renders `mrkdwn`, not standard markdown. |

`ts` is Slack's message id and doubles as the key for threading: reply to a message
by passing its `ts` (or its `threadTs` if it was already in a thread) as `threadTs`.

## Setup

### 1. Create a Slack app

Open [api.slack.com/apps](https://api.slack.com/apps), **Create New App → From
scratch**, pick a name and workspace.

### 2. Enable Socket Mode

Open **Socket Mode** in the sidebar and enable it. Slack prompts you to create an
**app-level token** with the `connections:write` scope — copy the `xapp-...` token.

### 3. Add bot token scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes** add:

- `chat:write` — send messages
- `app_mentions:read` — receive @-mentions
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — receive
  messages in public channels, private channels, DMs, and group DMs

### 4. Subscribe to events

Under **Event Subscriptions**, toggle **Enable Events** and add the bot events
`app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`.
(With Socket Mode on, no Request URL is asked for.)

### 5. Install and copy the bot token

Under **OAuth & Permissions**, click **Install to Workspace** and authorize. Copy the
**Bot User OAuth Token** (`xoxb-...`).

### 6. Install and onboard in wolli

```bash
wolli <agent> plugins install ./built-in/plugins/slack
```

Onboarding prompts for the bot token, then the app-level token, verifies them with
live `auth.test` and `apps.connections.open` calls, and stores them. If you installed
non-interactively, onboard later with `wolli <agent> plugins configure slack`.

### 7. Invite the bot and restart

The bot only receives channel messages where it is a member — run `/invite @yourbot`
in the channels it should hear. Then:

```bash
wolli restart <agent>
```

## Configuration reference

Configuration lives per agent in `~/.wolli/agents/<name>/integrations.json`:

```json
{
  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C0123456789"]
  }
}
```

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `botToken` | Yes | — | Bot token for all Web API calls. Onboarding stores it raw; a `$ENV` / `!cmd` reference placed here by hand also resolves on read. |
| `appToken` | Yes | — | App-level token, used only to open the Socket Mode connection. |
| `allowedChannelIds` | No | *(any channel)* | Allowlist of channel ids the integration emits events for. Empty or absent accepts **any** channel the bot can see (logged as a warning at startup). |

`allowedChannelIds` is not asked during onboarding — edit `integrations.json` to set
it. Channel ids look like `C0123456789`; grab one from a channel's **View channel
details → About** panel.

## Not supported

- DM routing — DM `message` events are emitted by the integration (with the `im`
  scopes and event subscriptions) but the chat workflow does not route them.
- Inbound media, file uploads, edits, deletions, or reactions.
- Slash commands and interactive payloads (buttons, modals) — their envelopes are
  acked and dropped.
- Durable event dedupe: envelopes are acked on receipt, so a Slack retry after a
  crash can re-emit an event.
- HTTP Events API mode — Socket Mode only.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Connects but no `message` events | Subscribe to the `message.*` bot events (step 4) and reinstall the app; then check the bot is a member of the channel (`/invite @yourbot`). |
| `invalid_auth` / `not_authed` | Wrong token in the wrong field — `botToken` is `xoxb-...`, `appToken` is `xapp-...`. |
| `not_in_channel` on sendMessage | Invite the bot to the channel first. |
| Bot never answers a mention | Check the `app_mention` bot event is subscribed (step 4) and the agent was restarted after install. |

## Security

- `allowedChannelIds` is the only access gate today. With it empty, **any** channel
  the bot can see is accepted — set it to lock the integration to known channels.
- There is no per-user gate. Anyone who can post where the bot listens can drive the
  agent, so keep the bot in trusted channels.
- The tokens grant control of the bot — never commit them. Wolli writes
  `integrations.json` with mode `0600`.
