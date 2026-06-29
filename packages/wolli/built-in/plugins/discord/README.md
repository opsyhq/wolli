# Discord

Connect a wolli agent to Discord. The bot runs over Discord's gateway WebSocket,
gives each channel and DM its own wolli session, and replies in place. Setup is a
few clicks in the Discord Developer Portal plus a single token prompt.

## How the bot behaves

Before setup, here's the part most people want to know: this bot answers
**everything it can read**. There is no `@mention` gate.

| Context | Behavior |
|---------|----------|
| **DMs** | Responds to every non-empty message. |
| **Server channels** | Responds to every non-empty message in any channel it can read. No `@mention` required — unlike some Discord agents, the bot replies to plain messages. Scope where it listens with `allowedChannelIds`. |
| **Other bots / itself** | Ignored. The bot skips its own messages and messages from any other bot, so it can't loop. |
| **Empty / media-only messages** | Skipped (there is no inbound media handling). |

While a turn runs, the bot shows Discord's **typing…** indicator in the channel and
keeps it alive until the reply lands. Replies are chunked at **2000 characters**
(Discord's per-message limit); Discord renders markdown natively, so formatting in
the agent's output comes through as-is.

If a new message arrives while the agent is mid-reply, it is **queued as a
follow-up** and answered after the current turn finishes — it does not interrupt the
in-flight response.

## Session model

Each channel and DM gets its **own wolli session**, bound by a `discord:channel`
tag:

- **Inbound** — an incoming message is routed to the session tagged for its channel.
  If none exists yet, one is created and tagged on the spot. Histories never bleed
  across channels, and two channels can run in parallel.
- **Outbound** — the reply rides the producing session's tag, so the answer always
  returns to the channel that started the turn — not to whoever messaged most
  recently.

## Setup

### 1. Create a Discord application

Open the [Discord Developer Portal](https://discord.com/developers/applications) and
click **New Application**. Name it (e.g. "Wolli") and accept the terms.

### 2. Enable the Message Content Intent

This is the critical step. Open **Bot** in the sidebar, scroll to **Privileged
Gateway Intents**, toggle **Message Content Intent** to **ON**, and **Save Changes**.

Without it, the bot still receives message events but the message text arrives
**empty**, so it can never reply. This is the single privileged intent the bot
needs — you do **not** need Server Members or Presence.

### 3. Reset and copy the bot token

On the same **Bot** page, click **Reset Token**, complete 2FA if prompted, and copy
the token. It is shown only once — if you lose it, reset and generate a new one. Keep
it secret.

### 4. Invite the bot

Open **OAuth2 → URL Generator** and select:

- **Scopes:** `bot`
- **Bot Permissions:** **View Channels**, **Send Messages**, **Read Message History**

Copy the generated URL at the bottom, open it, pick a server you administer, and
authorize. Only the `bot` scope is required — the `applications.commands` scope is
not needed.

### 5. Install and onboard in wolli

```bash
wolli <agent> plugins install ./built-in/plugins/discord
```

In an interactive terminal this runs onboarding immediately: it prints the connect
guide, then prompts you to **paste the bot token**. Paste the token from step 3.
Wolli verifies it with a live `GET /users/@me` call and stores it. That single token
is the only value you enter.

If you installed non-interactively, onboard later with:

```bash
wolli <agent> plugins configure discord
```

### 6. Restart the agent

```bash
wolli restart <agent>
```

This starts the gateway producer that connects to Discord. After onboarding a fresh
integration, restart the agent once so the bot comes online and begins responding.

## Configuration reference

Configuration lives per agent in `~/.wolli/agents/<name>/integrations.json` under
`discord.default`:

```json
{
  "discord": {
    "default": {
      "botToken": "...",
      "allowedChannelIds": ["123456789012345678"]
    }
  }
}
```

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `botToken` | Yes | — | The bot token. Onboarding stores it raw; a `$ENV` / `!cmd` reference placed here by hand also resolves on read. |
| `allowedChannelIds` | No | *(any channel)* | Allowlist of channel IDs the bot will respond in. Empty or absent accepts **any** channel the bot can read (logged as a warning at startup). |

Discord IDs are snowflakes — keep them as **quoted strings** in JSON, never numbers,
since a 64-bit snowflake exceeds JavaScript's safe-integer range. To grab a channel
ID, enable **Developer Mode** in Discord (Settings → Advanced), then right-click a
channel and **Copy Channel ID**.

`allowedChannelIds` is not asked during onboarding — edit `integrations.json` to set
it.

## Not supported

The bot is deliberately focused on text chat. It does not provide:

- Mention-gating — it answers every readable message, not only `@mentions`.
- User, role, or guild allowlists — channel-level `allowedChannelIds` is the only
  scope control.
- Threads or auto-threading.
- Reactions.
- Native Discord slash commands.
- Inbound or outbound media, attachments, or voice.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bot is online but never replies | Enable the **Message Content Intent** (step 2). Without it the message text arrives empty and there is nothing to answer. |
| `Disallowed intents` on connect | Same cause: the Message Content Intent is not enabled in the Developer Portal. |
| No reply right after the first install/onboard | Restart the agent (`wolli restart <agent>`) so the gateway producer starts. |
| Silence in one specific channel | The bot is missing **View Channels** / **Send Messages** there, or the channel isn't in `allowedChannelIds`. Try a DM to isolate. |

## Security

- `allowedChannelIds` is the only access gate today. With it empty, **any** channel
  the bot can read is accepted — set it to lock the bot to known channels.
- There is no per-user or per-role gate. Anyone who can post in an allowed channel
  can drive the agent, so keep the bot in trusted channels.
- The bot token grants full control of the bot account — never commit it or share
  it. Wolli writes `integrations.json` with mode `0600`.
