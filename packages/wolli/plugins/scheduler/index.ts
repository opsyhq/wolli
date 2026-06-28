/**
 * Scheduler integration — the timer half (self-contained package).
 *
 * This integration owns the jobs and the wake loop: it persists jobs in `ctx.store`
 * (one file at `~/.wolli/agents/<name>/store/scheduler.json`), ticks a coarse timer,
 * and emits a `due` event when a job's time arrives. It does not touch sessions or the
 * agent; the paired extension (`scheduler-chat.ts`) registers the agent-facing `cron`
 * tool and, on `due`, wakes a session. See `INTEGRATION.md` for the producer-vs-mapping
 * split.
 *
 * Jobs are scheduled by the agent through the `cron` tool, which calls the CRUD actions
 * below. The scheduler has no secret — onboarding just writes an empty `scheduler.default`
 * account so `run()` starts.
 *
 * ## Guarantees
 *  - At-most-once: a tick advances a job's `nextRunAt` (or disables a one-shot) and
 *    persists that BEFORE emitting `due`, so a crash/reload right after an emit never
 *    double-fires.
 *  - Missed runs while down: the catch-up tick on start fires each overdue job once
 *    (recompute-from-now), not one replay per missed interval.
 */

import { randomUUID } from "node:crypto";
import type { IntegrationOnboardContext, IntegrationsAPI, KeyValueStore } from "@opsyhq/wolli";
import { Cron } from "croner";
import { type Static, Type } from "typebox";

/** Default wake interval — coarse by design (a fixed tick is trivially idempotent across reloads). */
const DEFAULT_TICK_MS = 60_000;

const Schedule = Type.Union([
	/** One-shot at an absolute epoch-ms instant. */
	Type.Object({ kind: Type.Literal("at"), at: Type.Number() }),
	/** Fixed interval; the first run is one interval after creation. */
	Type.Object({ kind: Type.Literal("every"), everyMs: Type.Number() }),
	/** Cron expression; `tz` omitted = host local time. */
	Type.Object({ kind: Type.Literal("cron"), expr: Type.String(), tz: Type.Optional(Type.String()) }),
]);
type Schedule = Static<typeof Schedule>;

interface Job {
	id: string;
	name?: string;
	prompt: string;
	schedule: Schedule;
	enabled: boolean;
	/** Tags of the session that scheduled the job; the fired result is delivered to the newest session matching these. */
	originTags?: Record<string, string>;
	/** Epoch ms; advanced before firing. */
	nextRunAt: number;
	lastRunAt?: number;
}

interface SchedulerAccount {
	tickMs?: number;
}

/** Jobs live under the single store key `"jobs"`, keyed by id. */
function loadJobs(store: KeyValueStore): Record<string, Job> {
	return (store.get("jobs") as Record<string, Job> | undefined) ?? {};
}
function saveJobs(store: KeyValueStore, jobs: Record<string, Job>): void {
	store.set("jobs", jobs);
}

/** Next run for a schedule relative to `fromMs`; null when there is no future run. */
function computeNextRunAt(schedule: Schedule, fromMs: number): number | null {
	switch (schedule.kind) {
		case "at":
			return schedule.at;
		case "every":
			return fromMs + schedule.everyMs;
		case "cron":
			return new Cron(schedule.expr, { timezone: schedule.tz }).nextRun(new Date(fromMs))?.getTime() ?? null;
	}
}

async function onboard(ctx: IntegrationOnboardContext): Promise<Record<string, unknown>> {
	ctx.ui.notify("Scheduler enabled.", "info");
	return {};
}

export default function (wolli: IntegrationsAPI) {
	wolli.registerIntegration({
		name: "scheduler",
		account: Type.Object({
			/** Wake interval in ms; defaults to 60s. */
			tickMs: Type.Optional(Type.Number()),
		}),
		events: {
			due: Type.Object({
				id: Type.String(),
				prompt: Type.String(),
				originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
				name: Type.Optional(Type.String()),
			}),
		},
		onboard,
		actions: {
			addJob: {
				description: "Schedule a new job from a prompt and a schedule (at / every / cron).",
				parameters: Type.Object({
					prompt: Type.String(),
					name: Type.Optional(Type.String()),
					schedule: Schedule,
					originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
				execute: async (params, ctx) => {
					const p = params as {
						prompt: string;
						name?: string;
						schedule: Schedule;
						originTags?: Record<string, string>;
					};
					const now = Date.now();
					const seeded = computeNextRunAt(p.schedule, now);
					const job: Job = {
						id: randomUUID(),
						name: p.name,
						prompt: p.prompt,
						schedule: p.schedule,
						enabled: seeded !== null,
						originTags: p.originTags,
						nextRunAt: seeded ?? 0,
					};
					const jobs = loadJobs(ctx.store);
					jobs[job.id] = job;
					saveJobs(ctx.store, jobs);
					return { id: job.id, nextRunAt: job.nextRunAt };
				},
			},
			listJobs: {
				description: "List all scheduled jobs.",
				parameters: Type.Object({}),
				execute: async (_params, ctx) => {
					return { jobs: Object.values(loadJobs(ctx.store)) };
				},
			},
			updateJob: {
				description: "Update a job by id; recomputes the next run when the schedule changes.",
				parameters: Type.Object({
					id: Type.String(),
					prompt: Type.Optional(Type.String()),
					name: Type.Optional(Type.String()),
					schedule: Type.Optional(Schedule),
					enabled: Type.Optional(Type.Boolean()),
				}),
				execute: async (params, ctx) => {
					const p = params as {
						id: string;
						prompt?: string;
						name?: string;
						schedule?: Schedule;
						enabled?: boolean;
					};
					const jobs = loadJobs(ctx.store);
					const job = jobs[p.id];
					if (!job) throw new Error(`unknown job '${p.id}'`);

					if (p.prompt !== undefined) job.prompt = p.prompt;
					if (p.name !== undefined) job.name = p.name;
					if (p.enabled !== undefined) job.enabled = p.enabled;
					if (p.schedule !== undefined) {
						job.schedule = p.schedule;
						const next = computeNextRunAt(p.schedule, Date.now());
						job.nextRunAt = next ?? 0;
						if (next === null) job.enabled = false;
					}

					saveJobs(ctx.store, jobs);
					return { job };
				},
			},
			removeJob: {
				description: "Delete a job by id.",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (params, ctx) => {
					const { id } = params as { id: string };
					const jobs = loadJobs(ctx.store);
					const removed = id in jobs;
					delete jobs[id];
					saveJobs(ctx.store, jobs);
					return { removed };
				},
			},
			runJob: {
				description: "Run a job on the next tick (sets it due immediately).",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (params, ctx) => {
					const { id } = params as { id: string };
					const jobs = loadJobs(ctx.store);
					const job = jobs[id];
					if (!job) throw new Error(`unknown job '${id}'`);
					job.enabled = true;
					job.nextRunAt = 0;
					saveJobs(ctx.store, jobs);
					return { id, nextRunAt: job.nextRunAt };
				},
			},
		},
		run(ctx) {
			const account = ctx.account as SchedulerAccount;
			const tickMs = account.tickMs ?? DEFAULT_TICK_MS;

			const tick = (): void => {
				const now = Date.now();
				const jobs = loadJobs(ctx.store);
				const due: Job[] = [];
				for (const job of Object.values(jobs)) {
					if (!job.enabled || job.nextRunAt > now) continue;
					job.lastRunAt = now;
					if (job.schedule.kind === "at") {
						job.enabled = false; // one-shot
					} else {
						const next = computeNextRunAt(job.schedule, now);
						if (next === null) job.enabled = false;
						else job.nextRunAt = next;
					}
					due.push(job);
				}
				if (due.length === 0) return;

				// Persist the advanced state before emitting so a crash right after an emit never re-fires.
				saveJobs(ctx.store, jobs);
				for (const job of due) {
					ctx.emit("due", {
						id: job.id,
						prompt: job.prompt,
						originTags: job.originTags,
						name: job.name,
					});
				}
			};

			// One catch-up tick on start: each overdue job fires once (recompute-from-now), not N replays.
			tick();
			const timer = setInterval(tick, tickMs);

			const dispose = () => clearInterval(timer);
			ctx.signal.addEventListener("abort", dispose);
			return dispose;
		},
	});
}
