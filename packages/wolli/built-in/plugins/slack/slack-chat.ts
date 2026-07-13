/**
 * Slack chat routing, as one workflows file:
 *  - `mention` binds each mention thread to its own session by a `slack:thread` tag and
 *    delivers the mention text as a followUp. A mention posted outside a thread makes its
 *    own `ts` the thread root, so the reply opens the thread the session lives in.
 *  - `thread` continues tracked threads: replies inside a thread whose session exists are
 *    delivered as followUps without needing another mention. Untracked threads and
 *    non-thread channel chatter never route — the bot is mention-gated.
 *  - `reply` ships the turn's final assistant text back on `agent_end`, riding the
 *    producing session's `slack:thread` tag, threaded under the originating message.
 * Slack has no typing indicator for classic bots, so there is no typing workflow.
 */

import { wolli } from "wolli";
import slack from "./index.ts";

/** Tag value `${channelId}:${threadTs}` — channel ids never contain ":". */
function threadTag(channelId: string, threadTs: string): Record<string, string> {
	return { "slack:thread": `${channelId}:${threadTs}` };
}

// m is typed from the event schema
export const mention = slack.on("app_mention", async (m, ctx) => {
	// The mention is the thread root unless it was posted inside an existing thread.
	const tag = threadTag(m.channelId, m.threadTs ?? m.ts);
	const [match] = await ctx.agent.findSessions(tag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({
				setup: (s) => s.appendTags(tag),
			});
	// followUp queues behind a running turn instead of interrupting it.
	await session.sendUserMessage(m.text, { deliverAs: "followUp" });
});

export const thread = slack.on("message", async (m, ctx) => {
	if (!m.threadTs) return; // channel chatter outside threads never routes (mention-gated)
	const [match] = await ctx.agent.findSessions(threadTag(m.channelId, m.threadTs));
	if (!match) return; // untracked thread
	const session = await ctx.agent.openSession(match.id);
	await session.sendUserMessage(m.text, { deliverAs: "followUp" });
});

export const reply = wolli.on("agent_end", async (evt, ctx) => {
	const bound = ctx.session.getTags()["slack:thread"];
	if (!bound) return; // not a slack-bound session
	const sep = bound.indexOf(":");
	const channelId = bound.slice(0, sep);
	const threadTs = bound.slice(sep + 1);
	const text = evt.messages
		.filter((m) => m.role === "assistant")
		.at(-1)
		?.content.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!text) return; // a pure tool-call turn sends nothing
	await ctx.integration(slack).sendMessage({ channelId, text, threadTs });
});
