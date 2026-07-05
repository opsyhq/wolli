# Telegram

Connect a wolli agent to Telegram. The bot runs over Telegram's long-polling API,
gives each chat its own wolli session, and replies in place. Setup is one message to
[@BotFather](https://t.me/BotFather) plus a single token prompt — no public URL or
TLS is required.

## How the bot behaves

Before setup, here's the part most people want to know: this bot answers **every
text message it receives**. There is no `@mention` gate.

| Context | Behavior |
|---------|----------|
| **Private chats** | Responds to every text message. |
| **Group chats** | Responds to every text message it can see in any chat. No `@mention` required. Scope where it listens with `allowedChatIds`. |
| **Its own messages** | Ignored. The bot skips messages it sent itself, so it can't loop. |
| **Non-text messages** | Skipped. Photos, stickers, voice, and other media are not handled — only text messages reach the agent. |
| **Slash commands** | `/new`, `/status`, `/help` are handled locally and never sent to the model (see [Commands](#commands)). |

While a turn runs, the bot shows Telegram's **typing…** indicator and re-sends it
every ~4 seconds (Telegram clears the state on its own) until the reply lands.

Replies are chunked at **4096 characters** (Telegram's per-message limit) and each
chunk is sent with the configured **parse mode** (`MarkdownV2` by default). Telegram,
unlike Discord, needs a parse mode to render formatting — and if it rejects a chunk's
formatting, that chunk is **re-sent as plain text**, so a stray markdown character
never silently drops the reply.

If a new message arrives while the agent is mid-reply, it is **queued as a follow-up**
and answered after the current turn finishes — it does not interrupt the in-flight
response.

## Commands

These commands are registered as the bot's command menu at producer startup and are
handled locally by the inbound routing workflow, not forwarded to the model:

| Command | Action |
|---------|--------|
| `/new` | Start a fresh session for this chat. The new session becomes the active one; the previous session stays addressable but new messages route to the new one. |
| `/status` | Show the current session name and its current model. |
| `/help` | List the available commands. |

Any other `/command` returns `Unknown command: /<name>. Try /help.`

## Session model

Each chat gets its **own wolli session**, bound by a `telegram:chat` tag:

- **Inbound** — an incoming message is routed to the session tagged for its chat. If
  none exists yet, one is created and tagged on the spot. Histories never bleed across
  chats, and two chats can run in parallel.
- **Outbound** — the reply rides the producing session's tag, so the answer always
  returns to the chat that started the turn — not to whoever messaged most recently.

`/new` creates a fresh session tagged for the chat; because it becomes the newest
match for that tag, subsequent messages route to it.

## Setup

### 1. Create a bot with BotFather

Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`. Pick a name
and a username; BotFather replies with a **bot token** like `123456:ABC-DEF...`. Copy
it — you'll paste it in the next step. Keep it secret.

### 2. Install and onboard in wolli

```bash
wolli <agent> plugins install ./built-in/plugins/telegram
```

In an interactive terminal this runs onboarding immediately: it prints the BotFather
walkthrough, then prompts you to **paste the bot token**. Paste the token from step 1.
Wolli verifies it with a live `getMe()` call and stores it. That single token is the
only value you enter.

If you installed non-interactively, onboard later with:

```bash
wolli <agent> plugins configure telegram
```

### 3. Restart the agent

```bash
wolli restart <agent>
```

This starts the long-poll producer that connects to Telegram. After onboarding a
fresh integration its producer starts only on the next daemon start, so restart the
agent once for the bot to come online and begin responding.

## Configuration reference

Configuration lives per agent in `~/.wolli/agents/<name>/integrations.json` under
`telegram.default`:

```json
{
  "telegram": {
    "default": {
      "botToken": "123456:ABC-DEF...",
      "allowedChatIds": [123456789],
      "parseMode": "MarkdownV2"
    }
  }
}
```

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `botToken` | Yes | — | The BotFather token. Onboarding stores it raw; a `$ENV` / `!cmd` reference placed here by hand also resolves on read. |
| `allowedChatIds` | No | *(any chat)* | Allowlist of chat IDs the bot will respond in. Empty or absent accepts **any** chat (logged as a warning at startup). |
| `parseMode` | No | `MarkdownV2` | Outbound formatting: `"MarkdownV2"`, `"HTML"`, or `"plain"` (disables parse mode). |

Telegram chat IDs are **numbers** — keep them unquoted in JSON, unlike Discord's
quoted snowflakes.

`allowedChatIds` and `parseMode` are not asked during onboarding — edit
`integrations.json` to set them.

## Not supported

The bot is deliberately focused on text chat. It does not provide:

- A durable cursor — on start it calls `deleteWebhook({ drop_pending_updates: true })`,
  so a restart never replays a backlog but also drops messages sent while the bot was
  offline.
- Inbound media or images — only text messages are handled.
- Webhook mode — the transport is long polling only.
- Callback queries or inline keyboards.
- Outbound rate-limit throttling.
- Mention-gating, or per-user / per-role allowlists — chat-level `allowedChatIds` is
  the only scope control.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No reply right after the first install/onboard | Restart the agent (`wolli restart <agent>`) so the long-poll producer starts. |
| Bot ignores messages sent while it was offline | Expected — `deleteWebhook({ drop_pending_updates: true })` clears the backlog on start. The bot only sees messages that arrive while it is running. |
| Formatting looks broken, or a message seems to drop | A chunk that fails parse-mode parsing is re-sent as plain text. Set `parseMode: "plain"` to disable formatting entirely. |

## Security

- `allowedChatIds` is the only access gate. With it empty, **any** chat is accepted —
  set it to lock the bot to known chats.
- There is no per-user gate beyond that. Anyone who can post in an allowed chat can
  drive the agent, so keep the bot in trusted chats.
- The bot token grants full control of the bot account — never commit it or share it.
  Wolli writes `integrations.json` with mode `0600`.
