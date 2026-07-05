/**
 * Telegram chat routing, as one workflows file:
 *  - `inbound` binds each chat to its own session by a `telegram:chat` tag and delivers
 *    inbound text as a followUp. Slash commands (`/new`, `/status`, `/help`) are handled
 *    locally, before the session lookup, and never reach the model.
 *  - `typing` starts the "typing…" indicator on `agent_start`; the integration owns the
 *    keep-alive timer.
 *  - `reply` ships the turn's final assistant text back on `agent_end`, riding the
 *    producing session's `telegram:chat` tag; typing stops first so a pure tool-call turn
 *    still clears the indicator.
 */

import { type WorkflowContext, wolli } from "wolli";
import telegram from "./index.ts";

interface TelegramMessage {
	chatId: number;
	text: string;
}

/** Slash commands are handled locally instead of being sent to the model. */
async function handleCommand(msg: TelegramMessage, ctx: WorkflowContext): Promise<void> {
	const tg = ctx.integration(telegram);
	// Strip the leading "/" and an optional "@botname" suffix (groups append it).
	const command = msg.text.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase();
	const chatTag = { "telegram:chat": String(msg.chatId) };
	switch (command) {
		case "new": {
			// A fresh session tagged with this chat becomes the newest match, so future messages
			// route to it (the prior session stays addressable but is no longer the newest).
			await ctx.agent.createSession({ setup: (s) => s.appendTags(chatTag) });
			await tg.sendMessage({ chatId: msg.chatId, text: "Started a fresh session." });
			return;
		}
		case "status": {
			const [match] = await ctx.agent.findSessions(chatTag);
			const session = match ? await ctx.agent.openSession(match.id) : undefined;
			const name = session?.getSessionName() ?? "(none yet)";
			const model = session?.model?.id ?? "(none yet)";
			await tg.sendMessage({ chatId: msg.chatId, text: `Session: ${name}\nModel: ${model}` });
			return;
		}
		case "help": {
			const lines = [
				"/new — Start a fresh session",
				"/status — Show the current session and model",
				"/help — List available commands",
			].join("\n");
			await tg.sendMessage({ chatId: msg.chatId, text: `Commands:\n${lines}` });
			return;
		}
		default:
			await tg.sendMessage({ chatId: msg.chatId, text: `Unknown command: /${command}. Try /help.` });
	}
}

// msg is typed from the event schema
export const inbound = telegram.on("message", async (msg, ctx) => {
	if (msg.text.startsWith("/")) return handleCommand(msg, ctx);
	const chatTag = { "telegram:chat": String(msg.chatId) };
	const [match] = await ctx.agent.findSessions(chatTag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({
				setup: (s) => s.appendTags(chatTag),
			});
	// followUp queues behind a running turn instead of interrupting it.
	await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
});

export const typing = wolli.on("agent_start", async (_evt, ctx) => {
	const chat = ctx.session.getTags()["telegram:chat"];
	if (!chat) return; // not a telegram-bound session
	await ctx.integration(telegram).startTyping({ chatId: Number(chat) });
});

export const reply = wolli.on("agent_end", async (evt, ctx) => {
	const chat = ctx.session.getTags()["telegram:chat"];
	if (!chat) return; // not a telegram-bound session
	const chatId = Number(chat);
	// Stop the typing indicator before the empty-text early return, so a pure tool-call
	// turn still clears it.
	await ctx.integration(telegram).stopTyping({ chatId });
	const text = evt.messages
		.filter((m) => m.role === "assistant")
		.at(-1)
		?.content.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!text) return; // a pure tool-call turn sends nothing
	await ctx.integration(telegram).sendMessage({ chatId, text });
});
