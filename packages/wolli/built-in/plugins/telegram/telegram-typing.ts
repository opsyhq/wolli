/**
 * Telegram typing — on `agent_start`, starts the "typing…" indicator for a telegram-bound
 * session. The integration owns the keep-alive timer; `telegram-reply.ts` stops it on
 * `agent_end`.
 */

import { defineWorkflow } from "wolli";
import telegram from "./index.ts";

export default defineWorkflow({
	on: "agent_start",
	async run(_evt, ctx) {
		const chat = ctx.session.getTags()["telegram:chat"];
		if (!chat) return; // not a telegram-bound session
		await ctx.integration(telegram).startTyping({ chatId: Number(chat) });
	},
});
