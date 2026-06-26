/**
 * Scheduler chat extension — the mapping half (paired with `index.ts`).
 *
 * The integration (`index.ts`) is the producer (jobs, wake timer, `due` events); this
 * extension maps that onto the agent:
 *
 *   - tool:   registers the `cron` tool so the agent schedules its own jobs
 *             (add / list / update / remove / run) via the integration's CRUD actions.
 *   - inbound: `scheduler.on("due")` runs the job's prompt in the session it was scheduled from.
 *
 * Delivery via tags: `add` snapshots the scheduling session's tags onto the job (`originTags`).
 * When the job fires, the prompt runs as a turn in the newest session matching those tags, so
 * whatever extension owns that surface delivers the answer onward with no scheduler-side
 * special-casing — a telegram-tagged origin means telegram's own `agent_end` ships the reply
 * back to that chat. An untagged origin falls back to the newest session.
 *
 * This file is declared under the package's `steward.extensions` and is resolved in place by the
 * package manager when the integration is onboarded.
 */

import type { ExtensionAPI } from "@opsyhq/steward";
import { Type } from "typebox";

const CronParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("list"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("run"),
	]),
	prompt: Type.Optional(Type.String({ description: "What to run (the woken session's first message)." })),
	name: Type.Optional(Type.String({ description: "Human label for the job." })),
	at: Type.Optional(Type.Number({ description: "One-shot run time, epoch ms." })),
	everyMs: Type.Optional(Type.Number({ description: "Fixed interval in ms." })),
	cron: Type.Optional(Type.String({ description: "Cron expression (5/6-field)." })),
	tz: Type.Optional(Type.String({ description: "Timezone for the cron expression (host local if omitted)." })),
	id: Type.Optional(Type.String({ description: "Job id, for update / remove / run." })),
	enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the job (update)." })),
});

/** The fields of a job this extension reads back from `listJobs` (the integration owns the full shape). */
interface Job {
	id: string;
	name?: string;
	schedule: { kind: "at"; at: number } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
	enabled: boolean;
	nextRunAt: number;
}

/** Map the tool's flat `at`/`everyMs`/`cron` fields onto the integration's `Schedule` union. */
function buildSchedule(p: { at?: number; everyMs?: number; cron?: string; tz?: string }): Job["schedule"] | undefined {
	if (p.at !== undefined) return { kind: "at", at: p.at };
	if (p.everyMs !== undefined) return { kind: "every", everyMs: p.everyMs };
	if (p.cron !== undefined) return { kind: "cron", expr: p.cron, tz: p.tz };
	return undefined;
}

function describeSchedule(schedule: Job["schedule"]): string {
	switch (schedule.kind) {
		case "at":
			return `at ${new Date(schedule.at).toISOString()}`;
		case "every":
			return `every ${schedule.everyMs}ms`;
		case "cron":
			return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
	}
}

function text(message: string, details: unknown) {
	return { content: [{ type: "text" as const, text: message }], details };
}

export default function (steward: ExtensionAPI) {
	const sched = steward.getIntegration("scheduler", "default");

	steward.registerTool({
		name: "cron",
		label: "Cron",
		description:
			"Schedule prompts to run later. Actions: add (prompt + at/everyMs/cron), list, update (id), remove (id), run (id).",
		parameters: CronParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "add": {
						if (!params.prompt) return text("Error: prompt is required to add a job.", { error: "prompt required" });
						const schedule = buildSchedule(params);
						if (!schedule) {
							return text("Error: provide one of at, everyMs, or cron.", { error: "schedule required" });
						}
						// Snapshot the scheduling session's tags so the fired result returns to this surface.
						const result = (await sched.call("addJob", {
							prompt: params.prompt,
							name: params.name,
							schedule,
							originTags: ctx.session.getTags(),
						})) as { id: string; nextRunAt: number };
						return text(
							`Scheduled job ${result.id} — ${describeSchedule(schedule)} — next ${new Date(result.nextRunAt).toISOString()}.`,
							result,
						);
					}
					case "list": {
						const result = (await sched.call("listJobs")) as { jobs: Job[] };
						const body = result.jobs.length
							? result.jobs
									.map((j) => {
										const label = j.name ? `${j.name} ` : "";
										const state = j.enabled ? `next ${new Date(j.nextRunAt).toISOString()}` : "disabled";
										return `${j.id} ${label}— ${describeSchedule(j.schedule)} — ${state}`;
									})
									.join("\n")
							: "No scheduled jobs.";
						return text(body, result);
					}
					case "update": {
						if (!params.id) return text("Error: id is required to update a job.", { error: "id required" });
						const result = await sched.call("updateJob", {
							id: params.id,
							prompt: params.prompt,
							name: params.name,
							schedule: buildSchedule(params),
							enabled: params.enabled,
						});
						return text(`Updated job ${params.id}.`, result);
					}
					case "remove": {
						if (!params.id) return text("Error: id is required to remove a job.", { error: "id required" });
						const result = (await sched.call("removeJob", { id: params.id })) as { removed: boolean };
						return text(result.removed ? `Removed job ${params.id}.` : `No job ${params.id}.`, result);
					}
					case "run": {
						if (!params.id) return text("Error: id is required to run a job.", { error: "id required" });
						const result = await sched.call("runJob", { id: params.id });
						return text(`Job ${params.id} will run on the next tick.`, result);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return text(`Error: ${message}`, { error: message });
			}
		},
	});

	sched.on("due", async (data) => {
		const job = data as { id: string; prompt: string; originTags?: Record<string, string> };

		// Run the prompt as a turn in the session the job was scheduled from (newest match for its
		// origin tags). A telegram-tagged origin → telegram's own agent_end ships the reply to that
		// chat; no scheduler-side channel handling. followUp queues cleanly if a turn is in flight.
		// If no session matches (e.g. the origin was pruned), create one carrying the SAME origin tags
		// so it stays bound to that surface — never an untagged session, which would deliver nowhere.
		const [match] = await steward.findSessions(job.originTags ?? {});
		const session = match
			? await steward.openSession(match.id)
			: await steward.createSession({
					setup: async (sessionManager) => {
						await sessionManager.appendTags(job.originTags ?? {});
					},
				});
		await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
	});
}
