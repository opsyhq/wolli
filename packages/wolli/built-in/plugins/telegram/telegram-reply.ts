/**
 * Telegram reply — on `agent_end`, ships the turn's final assistant text back to the chat
 * that started it. The reply rides the producing session's `telegram:chat` tag, so the
 * answer returns to the right chat even when a scheduler or another workflow drove the turn.
 * Typing stops first, so a pure tool-call turn (no text to send) still clears the indicator.
 */

import { defineWorkflow } from "wolli";
import telegram from "./index.ts";

export default defineWorkflow({
	on: "agent_end",
	async run(evt, ctx) {
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
	},
});
