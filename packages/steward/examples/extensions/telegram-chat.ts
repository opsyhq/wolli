/**
 * Telegram chat extension — the mapping half.
 *
 * Pairs with `examples/integrations/telegram.ts`. The integration is the transport
 * (long-poll, token, `message` events); this extension maps that transport onto a
 * Steward session:
 *
 *   - inbound:  `telegram.on("message")` → `steward.sendUserMessage(text)` (one turn)
 *   - outbound: `steward.on("agent_end")` → final assistant text → `sendMessage`
 *   - typing:   `agent_start`/`agent_end` toggle the Telegram "typing…" indicator
 *   - commands: `/new`, `/status`, `/help` are handled here, not sent to the model
 *
 * v1 limitation — single session per process: Steward runs one agent session per
 * process, so every allowed chat funnels into the same session and replies go to the
 * last sender (`lastChatId`). For clean behavior, allowlist a single chat via
 * `allowedChatIds` in integrations.json. (INTEGRATION.md open question: "is one
 * external chat thread always one Steward user session?" — out of scope here.)
 *
 * Enable: copy this file to `~/.steward/agents/<name>/extensions/telegram-chat.ts`
 * and `telegram.ts` to `~/.steward/agents/<name>/integrations/`, then configure the
 * account in `integrations.json` (see telegram.ts header).
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

	// The chat to reply to. Updated on every inbound message; replies and the typing
	// indicator target whoever messaged last (see the single-session note above).
	let lastChatId: number | undefined;
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
				const { cancelled } = await steward.newSession();
				await reply(chatId, cancelled ? "Could not start a new session." : "Started a fresh session.");
				return;
			}
			case "status": {
				const name = steward.getSessionName() ?? "(unnamed)";
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
		lastChatId = m.chatId;

		if (m.text.startsWith("/")) {
			await handleCommand(m.chatId, m.text);
			return;
		}

		// followUp so a message arriving mid-stream queues cleanly instead of interrupting.
		steward.sendUserMessage(m.text, { deliverAs: "followUp" });
	});

	// Typing indicator: kept alive on a timer while a turn runs (Telegram clears the
	// "typing…" state after a few seconds, so it must be re-sent).
	const stopTyping = (): void => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	};

	steward.on("agent_start", async () => {
		if (lastChatId === undefined) return;
		const chatId = lastChatId;
		const sendTyping = () => {
			void tg.call("sendChatAction", { chatId, action: "typing" }).catch(() => {});
		};
		sendTyping();
		stopTyping();
		typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);
	});

	steward.on("agent_end", async ({ messages }) => {
		stopTyping();
		if (lastChatId === undefined) return;

		const assistantMsgs = messages as AgentMessage[];
		for (const m of assistantMsgs) {
			if (m.role === "assistant") lastModel = m.model;
		}

		const text = finalAssistantText(assistantMsgs);
		if (!text) return; // pure tool-call turn — nothing to send
		await reply(lastChatId, text);
	});
}
