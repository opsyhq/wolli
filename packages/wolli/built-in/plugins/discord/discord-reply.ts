/**
 * Discord reply — on `agent_end`, ships the turn's final assistant text back to the
 * channel that started it. The reply rides the producing session's `discord:channel` tag.
 * Typing stops first, so a pure tool-call turn (no text to send) still clears the indicator.
 */

import { defineWorkflow } from "wolli";
import discord from "./index.ts";

export default defineWorkflow({
	on: "agent_end",
	async run(evt, ctx) {
		const channelId = ctx.session.getTags()["discord:channel"];
		if (!channelId) return; // not a discord-bound session
		// Stop the typing indicator before the empty-text early return, so a pure tool-call
		// turn still clears it.
		await ctx.integration(discord).stopTyping({ channelId });
		const text = evt.messages
			.filter((m) => m.role === "assistant")
			.at(-1)
			?.content.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		if (!text) return; // a pure tool-call turn sends nothing
		await ctx.integration(discord).sendMessage({ channelId, text });
	},
});
