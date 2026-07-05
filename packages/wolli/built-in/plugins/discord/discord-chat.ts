/**
 * Discord chat routing, as one workflows file:
 *  - `inbound` binds each channel/DM to its own session by a `discord:channel` tag and
 *    delivers inbound text as a followUp. Discord has no channel commands, so every message
 *    routes into a session.
 *  - `typing` starts the "typing…" indicator on `agent_start`; the integration owns the
 *    keep-alive timer.
 *  - `reply` ships the turn's final assistant text back on `agent_end`, riding the
 *    producing session's `discord:channel` tag; typing stops first so a pure tool-call turn
 *    still clears the indicator.
 */

import { wolli } from "wolli";
import discord from "./index.ts";

// m is typed from the event schema
export const inbound = discord.on("message", async (m, ctx) => {
	const channelTag = { "discord:channel": m.channelId };
	const [match] = await ctx.agent.findSessions(channelTag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({
				setup: (s) => s.appendTags(channelTag),
			});
	// followUp queues behind a running turn instead of interrupting it.
	await session.sendUserMessage(m.text, { deliverAs: "followUp" });
});

export const typing = wolli.on("agent_start", async (_evt, ctx) => {
	const channelId = ctx.session.getTags()["discord:channel"];
	if (!channelId) return; // not a discord-bound session
	await ctx.integration(discord).startTyping({ channelId });
});

export const reply = wolli.on("agent_end", async (evt, ctx) => {
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
});
