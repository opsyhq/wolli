/**
 * Telegram chat integration — the transport half (self-contained package).
 *
 * This integration faces the network, holds the bot token, and emits a `message`
 * event per inbound Telegram message. It does not touch sessions or the agent; the
 * routing workflows (`telegram-chat.ts`, declared under `wolli.workflows`) map those
 * events onto sessions and are resolved in place by the package manager. In-memory transport state that outlives a single call —
 * the "typing…" keep-alive timers and the BotFather command menu — lives here, since
 * workflow files hold no module state.
 *
 * Transport is grammY long polling (`@grammyjs/runner`'s `run`), so no public URL
 * or TLS is needed. The package brings its OWN grammy + @grammyjs/runner deps.
 *
 * ## Install + configure
 *
 *   wolli <agent> plugins install ./built-in/plugins/telegram
 *   # then paste the BotFather token into the guided prompt — that's it.
 *
 * Onboarding asks for the BotFather token directly, verifies it with a live `getMe()`,
 * and stores the raw token in `~/.wolli/agents/<name>/integrations.json`:
 *
 *   { "telegram": { "botToken": "123456:ABC..." } }
 *
 * `botToken` is still resolved on read, so a `$ENV` / `!cmd` reference placed there by
 * hand keeps working — onboarding just stores the literal token. `allowedChatIds` is an
 * allowlist — empty/absent means "allow any chat" (logged as a warning). `parseMode`
 * is how outbound text is formatted (default `"MarkdownV2"`; `"plain"` disables it).
 * `allowedChatIds`/`parseMode` are not asked during onboarding — edit integrations.json
 * to set them.
 *
 * ## Known v1 limitations
 *  - No durable cursor: `run()` calls `deleteWebhook({ drop_pending_updates: true })`
 *    on start, so a restart never replays a backlog — but it also drops messages
 *    sent while the bot was offline. Acceptable for v1.
 *  - No inbound media/images, no webhook mode, no callback queries / inline keyboards.
 *  - No outbound throttling (add `@grammyjs/transformer-throttler` if rate limits bite).
 */

import { run } from "@grammyjs/runner";
// The integration surface is host-provided via the loader's VIRTUAL_MODULES / aliases, so
// wolli is a peerDependency, not a dependency.
import { defineIntegration, type IntegrationOnboardContext } from "wolli";
import { Bot, GrammyError } from "grammy";
import { Type } from "typebox";

/** Telegram caps a single message at 4096 UTF-16 code units. */
const TELEGRAM_MAX_LENGTH = 4096;

/** Typing indicator refresh interval — Telegram clears the "typing…" state after a few seconds. */
const TYPING_INTERVAL_MS = 4000;

/** BotFather slash-command menu, registered at producer start. */
const COMMANDS = [
	{ command: "new", description: "Start a fresh session" },
	{ command: "status", description: "Show the current session and model" },
	{ command: "help", description: "List available commands" },
];

/**
 * Live "typing…" keep-alive timers, keyed by chatId. Per-chat so parallel chats never
 * stomp each other; cleared by `stopTyping` and by the producer's disposer on reload,
 * so a reload can never orphan an interval.
 */
const typingTimers = new Map<number, ReturnType<typeof setInterval>>();

function stopTypingTimer(chatId: number): void {
	const timer = typingTimers.get(chatId);
	if (timer) {
		clearInterval(timer);
		typingTimers.delete(chatId);
	}
}

function clearAllTypingTimers(): void {
	for (const timer of typingTimers.values()) clearInterval(timer);
	typingTimers.clear();
}

/** BotFather walkthrough shown on the onboarding guide screen. */
const ONBOARD_GUIDE = [
	"## Connect Telegram",
	"",
	"1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.",
	"2. Pick a name and username; BotFather replies with a **bot token** like",
	"   `123456:ABC-DEF...`.",
	"3. Copy that token and paste it on the next screen.",
	"",
	"Wolli verifies the token and stores it for this agent.",
].join("\n");

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

/**
 * Guided setup: show the BotFather walkthrough, collect the bot token directly, verify
 * it with a live `getMe()`, and return the raw token to store. Returns `undefined`
 * (cancelled) if the user dismisses a step, submits nothing, or verification fails.
 */
async function onboard(ctx: IntegrationOnboardContext): Promise<{ botToken: string } | undefined> {
	// Guide text — onboarding renders over the wire (the daemon is the single writer), so the BotFather
	// walkthrough prints as a notification ahead of the token prompt rather than a custom guide screen.
	ctx.ui.notify(ONBOARD_GUIDE, "info");

	// undefined = cancelled. The pasted value is the raw token itself, not a reference.
	const entered = await ctx.ui.input("Paste the bot token from BotFather");
	if (entered === undefined) return undefined; // cancelled
	const token = entered.trim();
	if (!token) {
		ctx.ui.notify("No token entered.", "error");
		return undefined;
	}

	try {
		const me = await new Bot(token).api.getMe();
		ctx.ui.notify(`Verified bot @${me.username}.`, "info");
	} catch (err) {
		ctx.ui.notify(`Could not verify the token: ${err instanceof Error ? err.message : String(err)}`, "error");
		return undefined;
	}

	return { botToken: token };
}

export default defineIntegration({
	account: Type.Object({
		/** BotFather token. Onboarding stores it raw; a `$ENV`/`!cmd` reference also works. */
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
	onboard,
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
		startTyping: {
			description: "Show the 'typing…' indicator in a chat and keep it alive on a timer until stopTyping.",
			parameters: Type.Object({
				chatId: Type.Number(),
			}),
			execute: async (params, ctx) => {
				const { chatId } = params as { chatId: number };
				const account = ctx.account as TelegramAccount;
				const bot = getBot(account.botToken);
				const send = () => {
					void bot.api.sendChatAction(chatId, "typing").catch(() => {});
				};
				send(); // immediate first tick; Telegram would otherwise show nothing until the interval
				stopTypingTimer(chatId); // replace any existing timer for this chat
				typingTimers.set(chatId, setInterval(send, TYPING_INTERVAL_MS));
				return { ok: true };
			},
		},
		stopTyping: {
			description: "Stop the 'typing…' indicator in a chat.",
			parameters: Type.Object({
				chatId: Type.Number(),
			}),
			execute: async (params) => {
				const { chatId } = params as { chatId: number };
				stopTypingTimer(chatId);
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

		// Register the BotFather slash-command menu — transport-level registration, re-run each
		// reload. Fire-and-forget: a menu-registration failure must not block the poller.
		void bot.api.setMyCommands(COMMANDS).catch((err) => {
			console.error("[telegram] failed to register command menu:", err instanceof Error ? err.message : err);
		});

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
			// Clear typing timers here so a reload can never orphan an interval.
			clearAllTypingTimers();
			if (runner?.isRunning()) void runner.stop();
		};
		ctx.signal.addEventListener("abort", dispose);
		return dispose;
	},
});
