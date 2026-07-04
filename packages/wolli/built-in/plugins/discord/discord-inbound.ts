/**
 * Discord inbound routing — binds each channel/DM to its own session by a
 * `discord:channel` tag and delivers inbound text as a followUp. Discord has no channel
 * commands, so every message routes into a session.
 */

import { defineWorkflow } from "wolli";
import discord from "./index.ts";

export default defineWorkflow({
	on: discord.events.message, // m is typed from the event schema
	async run(m, ctx) {
		const channelTag = { "discord:channel": m.channelId };
		const [match] = await ctx.agent.findSessions(channelTag);
		const session = match
			? await ctx.agent.openSession(match.id)
			: await ctx.agent.createSession({
					setup: (s) => s.appendTags(channelTag),
				});
		// followUp queues behind a running turn instead of interrupting it.
		await session.sendUserMessage(m.text, { deliverAs: "followUp" });
	},
});
