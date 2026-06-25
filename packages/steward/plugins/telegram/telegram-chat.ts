/**
 * Telegram chat extension — the mapping half (paired with `index.ts`).
 *
 * The integration (`index.ts`) is the transport (long-poll, token, `message` events);
 * this extension maps that transport onto a Steward session:
 *
 *   - inbound:  `telegram.on("message")` tags the live session `{ "telegram:chat": <id> }`,
 *               then `steward.getConversation()?.sendUserMessage(text)` (one turn)
 *   - outbound: `steward.on("agent_end")` reads the PRODUCING session's tag off
 *               `ctx.conversation.getTags()` → final assistant text → `sendMessage`
 *   - typing:   `agent_start`/`agent_end` toggle the Telegram "typing…" indicator
 *   - commands: `/new`, `/status`, `/help` are handled here, not sent to the model
 *
 * Session binding via tags: the chat→session binding lives on the session as a tag, not in a
 * mutable "last sender" closure — so a reply returns to the chat that started the turn, and any
 * extension can locate this session with `steward.findSessions({ "telegram:chat": <id> })`. At N=1
 * allowlisting a single chat via `allowedChatIds` in integrations.json is still the cleanest setup.
 *
 * This file is declared under the package's `steward.extensions` and is copied into
 * `<agent>/extensions/` automatically when the integration is onboarded
 * (`steward integrations configure <agent> telegram`); it activates on the next launch.
 */

import type { AgentMessage } from "@opsyhq/agent";
import type { ExtensionAPI } from "@opsyhq/steward";

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

export default function (steward: ExtensionAPI) {
	const tg = steward.getIntegration("telegram", "default");

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
				const conversation = steward.getConversation();
				const cancelled = conversation ? (await conversation.newSession()).cancelled : true;
				await reply(chatId, cancelled ? "Could not start a new session." : "Started a fresh session.");
				return;
			}
			case "status": {
				const name = steward.getConversation()?.getSessionName() ?? "(unnamed)";
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
		const conversation = steward.getConversation();

		// Bind this chat to the live session so outbound + typing recover it from the producing session.
		conversation?.setTags({ "telegram:chat": String(m.chatId) });

		if (m.text.startsWith("/")) {
			await handleCommand(m.chatId, m.text);
			return;
		}

		// followUp so a message arriving mid-stream queues cleanly instead of interrupting.
		void conversation?.sendUserMessage(m.text, { deliverAs: "followUp" });
	});

	// Typing indicator: kept alive on a timer while a turn runs (Telegram clears the
	// "typing…" state after a few seconds, so it must be re-sent).
	const stopTyping = (): void => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	};

	steward.on("agent_start", async (_event, ctx) => {
		const chat = ctx.conversation.getTags()["telegram:chat"];
		if (!chat) return; // not a telegram-bound session
		const chatId = Number(chat);
		const sendTyping = () => {
			void tg.call("sendChatAction", { chatId, action: "typing" }).catch(() => {});
		};
		sendTyping();
		stopTyping();
		typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);
	});

	steward.on("agent_end", async ({ messages }, ctx) => {
		stopTyping();

		const assistantMsgs = messages as AgentMessage[];
		for (const m of assistantMsgs) {
			if (m.role === "assistant") lastModel = m.model;
		}

		// Reply rides the producing session's binding, so the answer returns to the chat that
		// started this turn — not whoever messaged last.
		const chat = ctx.conversation.getTags()["telegram:chat"];
		if (!chat) return; // not a telegram-bound session

		const text = finalAssistantText(assistantMsgs);
		if (!text) return; // pure tool-call turn — nothing to send
		await reply(Number(chat), text);
	});
}
