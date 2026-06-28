/**
 * Telegram chat extension — the mapping half (paired with `index.ts`).
 *
 * The integration (`index.ts`) is the transport (long-poll, token, `message` events);
 * this extension maps that transport onto a Wolli session:
 *
 *   - inbound:  `telegram.on("message")` routes the text into this chat's own session by
 *               `wolli.findSessions({ "telegram:chat": <id> })` → `openSession` the match (or
 *               `createSession` + tag a fresh one) → `session.sendUserMessage(text)`
 *   - outbound: `wolli.on("agent_end")` reads the PRODUCING session's tag off
 *               `ctx.session.getTags()` → final assistant text → `sendMessage`
 *   - typing:   `agent_start`/`agent_end` toggle the Telegram "typing…" indicator
 *   - commands: `/new`, `/status`, `/help` are handled here, not sent to the model
 *
 * Session binding via tags: each chat gets its OWN Wolli session, bound by a `{ "telegram:chat":
 * <id> }` tag. `findSessions` locates (and `createSession` lazily creates) the chat's session, so two
 * chats run in parallel and a reply returns to the chat that started the turn — located by any
 * extension with `wolli.findSessions({ "telegram:chat": <id> })`.
 *
 * This file is declared under the package's `wolli.extensions` and is resolved in place by the
 * package manager when the integration is onboarded
 * (`wolli <agent> plugins configure telegram`); it activates on the next launch.
 */

import type { AgentMessage } from "@opsyhq/agent";
import type { ExtensionAPI } from "@opsyhq/wolli";

const TYPING_INTERVAL_MS = 4000;

const COMMANDS = [
	{ command: "new", description: "Start a fresh session" },
	{ command: "status", description: "Show the current session and model" },
	{ command: "help", description: "List available commands" },
];

interface TelegramMessage {
	chatId: number;
	messageId: number;
	text: string;
	from: { id: number; username?: string; firstName?: string };
	chatType: string;
	date: number;
}

/** Concatenate the text blocks of the last assistant message; "" for a pure tool-call turn. */
function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		return m.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	}
	return "";
}

export default function (wolli: ExtensionAPI) {
	const tg = wolli.getIntegration("telegram", "default");

	// Model id from the most recent turn, surfaced by /status.
	let lastModel: string | undefined;
	let typingTimer: ReturnType<typeof setInterval> | undefined;

	const reply = async (chatId: number, text: string): Promise<void> => {
		await tg.call("sendMessage", { chatId, text });
	};

	// Register the BotFather slash-command menu on startup.
	void tg.call("setCommands", { commands: COMMANDS }).catch((err) => {
		console.error("[telegram-chat] setCommands failed:", err instanceof Error ? err.message : err);
	});

	// Slash commands are handled locally instead of being sent to the model.
	async function handleCommand(chatId: number, text: string): Promise<void> {
		// Strip a leading "/" and an optional "@botname" suffix (groups append it).
		const command = text.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase();
		switch (command) {
			case "new": {
				// A fresh session tagged with this chat becomes the newest match, so future messages
				// route to it (the prior session stays addressable but is no longer the newest).
				await wolli.createSession({
					setup: async (sessionManager) => {
						await sessionManager.appendTags({ "telegram:chat": String(chatId) });
					},
				});
				await reply(chatId, "Started a fresh session.");
				return;
			}
			case "status": {
				const matches = await wolli.findSessions({ "telegram:chat": String(chatId) });
				const name = (matches[0] && wolli.getSession(matches[0].id)?.getSessionName()) ?? "(unnamed)";
				const model = lastModel ?? "(unknown until first reply)";
				await reply(chatId, `Session: ${name}\nModel: ${model}`);
				return;
			}
			case "help": {
				const lines = COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");
				await reply(chatId, `Commands:\n${lines}`);
				return;
			}
			default:
				await reply(chatId, `Unknown command: /${command}. Try /help.`);
		}
	}

	tg.on("message", async (data) => {
		const m = data as TelegramMessage;

		if (m.text.startsWith("/")) {
			await handleCommand(m.chatId, m.text);
			return;
		}

		// Route into this chat's own session: rehydrate the tag-bound one, or create + tag a fresh one.
		const chatTag = { "telegram:chat": String(m.chatId) };
		const [match] = await wolli.findSessions(chatTag);
		const session = match
			? await wolli.openSession(match.id)
			: await wolli.createSession({
					setup: async (sessionManager) => {
						await sessionManager.appendTags(chatTag);
					},
				});

		// followUp so a message arriving mid-stream queues cleanly instead of interrupting.
		void session.sendUserMessage(m.text, { deliverAs: "followUp" });
	});

	// Typing indicator: kept alive on a timer while a turn runs (Telegram clears the
	// "typing…" state after a few seconds, so it must be re-sent).
	const stopTyping = (): void => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	};

	wolli.on("agent_start", async (_event, ctx) => {
		const chat = ctx.session.getTags()["telegram:chat"];
		if (!chat) return; // not a telegram-bound session
		const chatId = Number(chat);
		const sendTyping = () => {
			void tg.call("sendChatAction", { chatId, action: "typing" }).catch(() => {});
		};
		sendTyping();
		stopTyping();
		typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);
	});

	wolli.on("agent_end", async ({ messages }, ctx) => {
		stopTyping();

		const assistantMsgs = messages as AgentMessage[];
		for (const m of assistantMsgs) {
			if (m.role === "assistant") lastModel = m.model;
		}

		// Reply rides the producing session's binding, so the answer returns to the chat that
		// started this turn — not whoever messaged last.
		const chat = ctx.session.getTags()["telegram:chat"];
		if (!chat) return; // not a telegram-bound session

		const text = finalAssistantText(assistantMsgs);
		if (!text) return; // pure tool-call turn — nothing to send
		await reply(Number(chat), text);
	});
}
