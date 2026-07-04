/**
 * Scheduler due routing — on a `due` event, runs the job's prompt as a turn in the session
 * it was scheduled from (the newest match for the job's origin tags). A telegram-tagged
 * origin means telegram's own `agent_end` ships the reply back to that chat; no
 * scheduler-side channel handling. If no session matches (the origin was pruned), a fresh
 * one is created carrying the SAME origin tags so it stays bound to that surface — never
 * an untagged session, which would deliver nowhere.
 */

import { defineWorkflow } from "wolli";
import scheduler from "./index.ts";

export default defineWorkflow({
	on: scheduler.events.due,
	async run(job, ctx) {
		const originTags = job.originTags ?? {};
		const [match] = await ctx.agent.findSessions(originTags);
		const session = match
			? await ctx.agent.openSession(match.id)
			: await ctx.agent.createSession({
					setup: (s) => s.appendTags(originTags),
				});
		// followUp queues cleanly if a turn is in flight.
		await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
	},
});
