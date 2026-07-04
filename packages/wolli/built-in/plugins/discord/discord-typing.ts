/**
 * Discord typing — on `agent_start`, starts the "typing…" indicator for a discord-bound
 * session. The integration owns the keep-alive timer; `discord-reply.ts` stops it on
 * `agent_end`.
 */

import { defineWorkflow } from "wolli";
import discord from "./index.ts";

export default defineWorkflow({
	on: "agent_start",
	async run(_evt, ctx) {
		const channelId = ctx.session.getTags()["discord:channel"];
		if (!channelId) return; // not a discord-bound session
		await ctx.integration(discord).startTyping({ channelId });
	},
});
