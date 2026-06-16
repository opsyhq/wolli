# Examples

Example code for the Steward SDK and extensions.

## Directories

### [sdk/](sdk/)
Programmatic usage of Steward. Shows how to customize models, prompts, tools, extensions, context files, settings, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers (tool interception, safety gates, context modifications)
- Custom tools (todo lists, questions, subagents, output truncation)
- Commands and keyboard shortcuts
- Custom UI (footers, headers, editors, overlays)
- Git integration (checkpoints, auto-commit)
- System prompt modifications and custom compaction
- External integrations (SSH, file watchers, system theme sync)

## Integrations

### Telegram

Turn a Steward agent into a Telegram chat bot. It ships as two copyable files — a
transport ([integrations/telegram.ts](integrations/telegram.ts)) and a session
mapping ([extensions/telegram-chat.ts](extensions/telegram-chat.ts)) — using grammY
long polling (no public URL or TLS).

**Enable:**

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token, and export it:
   ```sh
   export TELEGRAM_BOT_TOKEN=123456:ABC...
   ```
2. Copy both files into your agent home:
   ```sh
   cp examples/integrations/telegram.ts   ~/.steward/agents/<name>/integrations/telegram.ts
   cp examples/extensions/telegram-chat.ts ~/.steward/agents/<name>/extensions/telegram-chat.ts
   ```
3. Add the account to `~/.steward/agents/<name>/integrations.json` (use your own chat
   id — message [@userinfobot](https://t.me/userinfobot) to find it):
   ```json
   { "telegram": { "default": { "botToken": "$TELEGRAM_BOT_TOKEN", "allowedChatIds": [123456789] } } }
   ```
4. Run `steward <name>` and message the bot. You should see a typing indicator, then
   the agent's reply. `/status`, `/new`, and `/help` are handled locally.

**Account fields** (`integrations.json`):
- `botToken` — BotFather token; store as `"$TELEGRAM_BOT_TOKEN"` (resolved on read).
- `allowedChatIds` — allowlist of chat ids. Empty/absent allows any chat (logged as a warning).
- `parseMode` — `"MarkdownV2"` (default), `"HTML"`, or `"plain"`. Outbound text is chunked
  at 4096 and, if Telegram rejects the formatting, resent as plain text.

**Known v1 limitations:**
- One Steward session per process: all allowed chats share one session and replies go
  to the last sender. Allowlist a single chat for clean behavior.
- No durable cursor: the bot drops pending updates on start, so a restart won't replay a
  backlog (it also drops messages sent while offline).
- No inbound media/images, no webhook mode, no inline keyboards, no outbound throttling.

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
- [Prompt Templates](../docs/prompt-templates.md)
- [Themes](../docs/themes.md)
