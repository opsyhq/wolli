/**
 * Scheduler integration — the wake loop the producer exists to deliver, exercised
 * against the real `plugins/scheduler/index.ts` factory with an in-memory account +
 * state store (no agent home, no chat turn).
 *
 *  1. a due one-shot `at` job fires once and flips to `enabled:false`;
 *  2. an `every` job advances `nextRunAt` and does not double-fire in one window;
 *  3. jobs survive a producer teardown→restart over a shared store (the reload path);
 *  4. the CRUD actions round-trip;
 *  5. malformed `addJob` params reject at the validation boundary.
 */

import { describe, expect, it } from "vitest";
import scheduler from "../plugins/scheduler/index.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	createIntegrationRuntime,
	type IntegrationHandle,
	IntegrationRunner,
	loadIntegrationFromFactory,
} from "../src/core/integrations/index.ts";

interface Job {
	id: string;
	name?: string;
	prompt: string;
	enabled: boolean;
	nextRunAt: number;
}

interface Due {
	id: string;
	prompt: string;
	target: string;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a bound runner over the given store, with a fast 5ms tick. */
async function buildRunner(store: IntegrationStore, tickMs = 5): Promise<IntegrationRunner> {
	const runtime = createIntegrationRuntime();
	const integration = await loadIntegrationFromFactory(scheduler, process.cwd(), runtime, "<scheduler>");
	const accounts = IntegrationAccountStorage.inMemory({ scheduler: { default: { tickMs } } });
	const runner = new IntegrationRunner([integration], runtime, process.cwd(), accounts, store);
	runner.bindCore();
	return runner;
}

async function listJobs(handle: IntegrationHandle): Promise<Job[]> {
	const { jobs } = (await handle.call("listJobs")) as { jobs: Job[] };
	return jobs;
}

describe("scheduler integration", () => {
	it("fires a due one-shot `at` job once and disables it", async () => {
		const runner = await buildRunner(IntegrationStore.inMemory());
		const handle = runner.getIntegration("scheduler", "default");

		const due: Due[] = [];
		handle.on("due", (d) => {
			due.push(d as Due);
		});

		await handle.call("addJob", { prompt: "hi", schedule: { kind: "at", at: Date.now() - 1 } });
		await runner.start();

		await waitFor(() => due.length >= 1);
		expect(due[0].prompt).toBe("hi");

		const jobs = await listJobs(handle);
		expect(jobs[0].enabled).toBe(false);

		const fired = due.length;
		await sleep(40); // several 5ms ticks — a one-shot must not re-fire
		expect(due.length).toBe(fired);

		await runner.stop();
	});

	it("advances an `every` job's nextRunAt and does not double-fire in one window", async () => {
		const runner = await buildRunner(IntegrationStore.inMemory());
		const handle = runner.getIntegration("scheduler", "default");

		const due: Due[] = [];
		handle.on("due", (d) => {
			due.push(d as Due);
		});

		// everyMs far larger than the test window; runJob forces it due on the next tick.
		const { id } = (await handle.call("addJob", {
			prompt: "tick",
			schedule: { kind: "every", everyMs: 3_600_000 },
		})) as { id: string };
		await handle.call("runJob", { id });
		await runner.start();

		await waitFor(() => due.length >= 1);
		await sleep(40);
		expect(due.length).toBe(1); // advanced ~1h out, so exactly one fire in this window

		const jobs = await listJobs(handle);
		expect(jobs[0].enabled).toBe(true);
		expect(jobs[0].nextRunAt).toBeGreaterThan(Date.now());

		await runner.stop();
	});

	it("survives a producer teardown→restart over a shared store", async () => {
		const store = IntegrationStore.inMemory();

		const runnerA = await buildRunner(store);
		const handleA = runnerA.getIntegration("scheduler", "default");
		// Future job so it does not fire under runner A.
		const { id } = (await handleA.call("addJob", {
			prompt: "survive",
			schedule: { kind: "at", at: Date.now() + 50_000 },
		})) as { id: string };
		await runnerA.start();
		await runnerA.stop();

		// New producer over the SAME store — the reload path; the job must still be there.
		const runnerB = await buildRunner(store);
		const handleB = runnerB.getIntegration("scheduler", "default");
		expect((await listJobs(handleB)).some((j) => j.id === id)).toBe(true);

		// And it still fires once forced due.
		const due: Due[] = [];
		handleB.on("due", (d) => {
			due.push(d as Due);
		});
		await handleB.call("runJob", { id });
		await runnerB.start();
		await waitFor(() => due.some((d) => d.id === id));

		await runnerB.stop();
	});

	it("round-trips the CRUD actions", async () => {
		const runner = await buildRunner(IntegrationStore.inMemory());
		const handle = runner.getIntegration("scheduler", "default");

		const { id } = (await handle.call("addJob", {
			prompt: "p",
			name: "n",
			schedule: { kind: "every", everyMs: 1000 },
		})) as { id: string };
		expect((await listJobs(handle))[0].name).toBe("n");

		await handle.call("updateJob", { id, prompt: "p2", enabled: false });
		let jobs = await listJobs(handle);
		expect(jobs[0].prompt).toBe("p2");
		expect(jobs[0].enabled).toBe(false);

		// Changing the schedule recomputes nextRunAt.
		await handle.call("updateJob", { id, schedule: { kind: "at", at: 5_000_000_000_000 } });
		jobs = await listJobs(handle);
		expect(jobs[0].nextRunAt).toBe(5_000_000_000_000);

		expect(((await handle.call("removeJob", { id })) as { removed: boolean }).removed).toBe(true);
		expect(await listJobs(handle)).toHaveLength(0);

		await expect(handle.call("updateJob", { id: "nope", prompt: "x" })).rejects.toThrow(/unknown job/);

		await runner.stop();
	});

	it("rejects malformed addJob params at the validation boundary", async () => {
		const runner = await buildRunner(IntegrationStore.inMemory());
		const handle = runner.getIntegration("scheduler", "default");

		// Missing schedule.
		await expect(handle.call("addJob", { prompt: "x" })).rejects.toThrow(/invalid params/);
		// Schedule union member missing its field.
		await expect(handle.call("addJob", { prompt: "x", schedule: { kind: "at" } })).rejects.toThrow(/invalid params/);
		// Missing prompt.
		await expect(handle.call("addJob", { schedule: { kind: "every", everyMs: 1 } })).rejects.toThrow(
			/invalid params/,
		);

		await runner.stop();
	});
});
