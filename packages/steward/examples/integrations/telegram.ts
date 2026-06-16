/**
 * Telegram chat integration — the transport half.
 *
 * This integration faces the network, holds the bot token, and emits a `message`
 * event per inbound Telegram message. It does not touch sessions or the agent; the
 * paired extension (`telegram-chat.ts`) maps those events into a chat loop. See
 * `INTEGRATION.md` for the transport-vs-mapping split.
 *
 * Transport is grammY long polling (`@grammyjs/runner`'s `run`), so no public URL
 * or TLS is needed.
 *
 * ## Configuration (`~/.steward/agents/<name>/integrations.json`)
 *
 *   {
 *     "telegram": {
 *       "default": {
 *         "botToken": "$TELEGRAM_BOT_TOKEN",
 *         "allowedChatIds": [123456789],
 *         "parseMode": "MarkdownV2"
 *       }
 *     }
 *   }
 *
 * `botToken` is resolved on read (`$ENV` / `!cmd` strings). `allowedChatIds` is an
 * allowlist — empty/absent means "allow any chat" (logged as a warning). `parseMode`
 * is how outbound text is formatted (default `"MarkdownV2"`; `"plain"` disables it).
 *
 * ## Known v1 limitations
 *  - No durable cursor: `run()` calls `deleteWebhook({ drop_pending_updates: true })`
 *    on start, so a restart never replays a backlog — but it also drops messages
 *    sent while the bot was offline. Acceptable for v1.
 *  - No inbound media/images, no webhook mode, no callback queries / inline keyboards.
 *  - No outbound throttling (add `@grammyjs/transformer-throttler` if rate limits bite).
 */

import { run } from "@grammyjs/runner";
import type { IntegrationsAPI } from "@opsyhq/steward";
import { Bot, GrammyError } from "grammy";
import { Type } from "typebox";

/** Telegram caps a single message at 4096 UTF-16 code units. */
const TELEGRAM_MAX_LENGTH = 4096;

type ParseMode = "MarkdownV2" | "HTML" | "plain";

interface TelegramAccount {
	botToken: string;
	allowedChatIds?: number[];
	parseMode?: ParseMode;
}

/**
 * One `Bot` instance per token, shared between the long-poll producer (`run`) and
 * the request/response actions so they reuse a single `bot.api`. A `Bot` is lazy —
 * constructing it makes no network call — so this is safe to build on first use.
 */
const bots = new Map<string, Bot>();
function getBot(token: string): Bot {
	let bot = bots.get(token);
	if (!bot) {
		bot = new Bot(token);
		bots.set(token, bot);
	}
	return bot;
}

/**
 * Split `text` into ≤4096-code-unit chunks without cutting a surrogate pair. JS
 * string length is already in UTF-16 code units, which is exactly Telegram's unit.
 */
function chunkText(text: string, max = TELEGRAM_MAX_LENGTH): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + max, text.length);
		if (end < text.length) {
			// If the boundary lands on a high surrogate, push it into the next chunk.
			const code = text.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) end -= 1;
		}
		chunks.push(text.slice(i, end));
		i = end;
	}
	return chunks;
}

/** A Telegram API error caused by parse-mode entity parsing (not e.g. a bad chat id). */
function isParseError(err: unknown): boolean {
	return err instanceof GrammyError && err.error_code === 400 && /can't parse|can't find|entit/i.test(err.description);
}

/**
 * Send one already-chunked message. Tries the configured parse mode first and, if
 * Telegram rejects the formatting, resends the same text as plain (no parse mode) so
 * a stray `*` or `_` from the model never silently drops the reply.
 */
async function sendChunk(
	bot: Bot,
	chatId: number,
	text: string,
	parseMode: ParseMode,
	replyToMessageId: number | undefined,
): Promise<number> {
	const reply = replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {};
	try {
		const other = parseMode === "plain" ? { ...reply } : { parse_mode: parseMode, ...reply };
		const sent = await bot.api.sendMessage(chatId, text, other);
		return sent.message_id;
	} catch (err) {
		if (parseMode === "plain" || !isParseError(err)) throw err;
		const sent = await bot.api.sendMessage(chatId, text, { ...reply });
		return sent.message_id;
	}
}

export default function (steward: IntegrationsAPI) {
	steward.registerIntegration({
		name: "telegram",
		account: Type.Object({
			/** BotFather token; store as `"$TELEGRAM_BOT_TOKEN"` in integrations.json. */
			botToken: Type.String(),
			/** Allowlist of chat ids. Empty/absent = allow all (logged as a warning). */
			allowedChatIds: Type.Optional(Type.Array(Type.Number())),
			/** Outbound formatting; `"plain"` disables parse mode. */
			parseMode: Type.Optional(
				Type.Union([Type.Literal("MarkdownV2"), Type.Literal("HTML"), Type.Literal("plain")]),
			),
		}),
		events: {
			message: Type.Object({
				chatId: Type.Number(),
				messageId: Type.Number(),
				text: Type.String(),
				from: Type.Object({
					id: Type.Number(),
					username: Type.Optional(Type.String()),
					firstName: Type.Optional(Type.String()),
				}),
				chatType: Type.String(),
				date: Type.Number(),
			}),
		},
		actions: {
			sendMessage: {
				description: "Send a text message to a chat (chunked at 4096, with plain-text fallback).",
				parameters: Type.Object({
					chatId: Type.Number(),
					text: Type.String(),
					replyToMessageId: Type.Optional(Type.Number()),
				}),
				execute: async (params, ctx) => {
					const { chatId, text, replyToMessageId } = params as {
						chatId: number;
						text: string;
						replyToMessageId?: number;
					};
					const account = ctx.account as TelegramAccount;
					const parseMode = account.parseMode ?? "MarkdownV2";
					const bot = getBot(account.botToken);

					const messageIds: number[] = [];
					// Reply-to applies only to the first chunk; later chunks just continue.
					let replyTo = replyToMessageId;
					for (const chunk of chunkText(text)) {
						messageIds.push(await sendChunk(bot, chatId, chunk, parseMode, replyTo));
						replyTo = undefined;
					}
					return { messageIds };
				},
			},
			sendChatAction: {
				description: "Show a chat action (e.g. the 'typing…' indicator).",
				parameters: Type.Object({
					chatId: Type.Number(),
					action: Type.String(),
				}),
				execute: async (params, ctx) => {
					const { chatId, action } = params as { chatId: number; action: string };
					const account = ctx.account as TelegramAccount;
					const bot = getBot(account.botToken);
					// grammY types `action` as a union; the runtime accepts any valid string.
					await bot.api.sendChatAction(chatId, action as "typing");
					return { ok: true };
				},
			},
			setCommands: {
				description: "Register the bot's slash-command menu (BotFather command list).",
				parameters: Type.Object({
					commands: Type.Array(
						Type.Object({
							command: Type.String(),
							description: Type.String(),
						}),
					),
				}),
				execute: async (params, ctx) => {
					const { commands } = params as { commands: { command: string; description: string }[] };
					const account = ctx.account as TelegramAccount;
					const bot = getBot(account.botToken);
					await bot.api.setMyCommands(commands);
					return { ok: true };
				},
			},
		},
		run(ctx) {
			const account = ctx.account as TelegramAccount;
			const { botToken, allowedChatIds } = account;
			const allowAll = !allowedChatIds || allowedChatIds.length === 0;
			if (allowAll) {
				console.warn("[telegram] no allowedChatIds configured — accepting messages from ANY chat.");
			}

			const bot = getBot(botToken);

			bot.on("message:text", (c) => {
				// Ignore our own messages and anything outside the allowlist.
				if (c.from?.id === c.me.id) return;
				const chatId = c.chat.id;
				if (!allowAll && !allowedChatIds?.includes(chatId)) return;

				ctx.emit("message", {
					chatId,
					messageId: c.msg.message_id,
					text: c.msg.text,
					from: {
						id: c.from?.id ?? 0,
						username: c.from?.username,
						firstName: c.from?.first_name,
					},
					chatType: c.chat.type,
					date: c.msg.date,
				});
			});

			// Swallow producer-side errors so a transient poll failure can't crash the host.
			bot.catch((err) => {
				console.error("[telegram] bot error:", err.message);
			});

			// Fire-and-forget startup: drop any webhook + backlog, then start long polling.
			// The runner never resolves, so we must NOT await it.
			let runner: ReturnType<typeof run> | undefined;
			void bot.api
				.deleteWebhook({ drop_pending_updates: true })
				.then(() => {
					if (ctx.signal.aborted) return;
					runner = run(bot);
				})
				.catch((err) => {
					console.error("[telegram] failed to start long polling:", err instanceof Error ? err.message : err);
				});

			// Belt and suspenders: stop the runner on abort and via the returned disposer.
			// The stop-before-start swap on reload relies on this to avoid Telegram's 409
			// ("two pollers on one token") conflict.
			const dispose = () => {
				if (runner?.isRunning()) void runner.stop();
			};
			ctx.signal.addEventListener("abort", dispose);
			return dispose;
		},
	});
}
