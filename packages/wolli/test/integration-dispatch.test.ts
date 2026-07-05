/**
 * Integration event dispatch: the two runner seams Phase 2 wires workflow dispatch
 * through, exercised against a defineIntegration heartbeat and in-memory stores.
 *
 *  - `onEvent` — the validated-event firehose: every valid emit from every service
 *    reaches subscribers; invalid payloads go to onError and never reach it;
 *    unsubscribe stops delivery.
 *  - `getIntegration(service).call(...)` — the action boundary `ctx.integration`
 *    dispatches through: params validated per call, with the documented errors for
 *    an unknown service and an unconfigured service. The flat typed handle itself
 *    is pinned purely at the type level (`IntegrationKey`/`IntegrationHandleOf`).
 *  - the composition the runtime wires in `buildSharedResources`: firehose events
 *    fan into a real WorkflowRunner's `dispatchIntegrationEvent` and land as
 *    recorded runs carrying the emitted payload.
 */

import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	defineIntegration,
	type IntegrationError,
	type IntegrationRunContext,
	IntegrationRunner,
	loadIntegrationFromDefinition,
} from "../src/core/integrations/index.ts";
import {
	defineWorkflow,
	type IntegrationHandleOf,
	type IntegrationKey,
	type StepStartRecord,
	type WorkflowAgentBackend,
	WorkflowRunner,
} from "../src/core/workflows/index.ts";

/** Poll `predicate` until true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The heartbeat definition plus a live runner over it; the producer hands out its `emit`. */
async function startHeartbeatRunner() {
	let capturedEmit: IntegrationRunContext["emit"] | undefined;
	const heartbeat = defineIntegration({
		events: { tick: Type.Object({ seq: Type.Number() }) },
		actions: {
			ping: {
				parameters: Type.Object({ echo: Type.String() }),
				// Params reached execute through callAction's schema validation, so the cast is sound.
				execute: async (params: unknown) => ({ ok: true, echo: (params as { echo: string }).echo }),
			},
		},
		run(ctx) {
			capturedEmit = ctx.emit;
		},
	});

	const integration = loadIntegrationFromDefinition(heartbeat, "<heartbeat>");
	const runner = new IntegrationRunner(
		[integration],
		process.cwd(),
		IntegrationAccountStorage.inMemory({ heartbeat: {} }),
		IntegrationStore.inMemory(),
	);
	runner.bindCore();
	await runner.start();

	const emit = capturedEmit;
	if (!emit) throw new Error("producer did not run");
	return { heartbeat, runner, emit };
}

describe("IntegrationRunner.onEvent", () => {
	it("delivers every validated emit, drops invalid ones, and honors unsubscribe", async () => {
		const { runner, emit } = await startHeartbeatRunner();
		const errors: IntegrationError[] = [];
		runner.onError((error) => errors.push(error));
		const events: Array<{ service: string; event: string; data: unknown }> = [];
		const unsubscribe = runner.onEvent((evt) => events.push(evt));

		emit("tick", { seq: 1 });
		expect(events).toEqual([{ service: "heartbeat", event: "tick", data: { seq: 1 } }]);

		// An invalid payload produces an error and never reaches the firehose.
		emit("tick", { seq: "x" });
		expect(errors.some((e) => /invalid 'tick' payload/.test(e.error))).toBe(true);
		expect(events).toHaveLength(1);

		unsubscribe();
		emit("tick", { seq: 2 });
		expect(events).toHaveLength(1);

		await runner.stop();
	});
});

describe("IntegrationRunner action dispatch", () => {
	it("invokes actions through the service handle, validating params per call", async () => {
		const { heartbeat, runner } = await startHeartbeatRunner();

		// The definition is the typed key `ctx.integration` accepts; `IntegrationHandleOf`
		// derives the flat handle — action set, params, and inferred return type.
		expectTypeOf(heartbeat).toExtend<IntegrationKey<NonNullable<(typeof heartbeat)["_actions"]>>>();
		expectTypeOf<IntegrationHandleOf<NonNullable<(typeof heartbeat)["_actions"]>>>().toEqualTypeOf<{
			ping: (params: { echo: string }) => Promise<{ ok: boolean; echo: string }>;
		}>();

		const handle = runner.getIntegration("heartbeat");
		await expect(handle.call("ping", { echo: "hi" })).resolves.toEqual({ ok: true, echo: "hi" });
		// Params are validated against the action schema per call.
		await expect(handle.call("ping", { echo: 7 })).rejects.toThrow(/invalid params for action 'ping'/);

		await runner.stop();
	});

	it("throws the documented errors for unknown and unconfigured services", async () => {
		const { runner } = await startHeartbeatRunner();

		expect(() => runner.getIntegration("ghost")).toThrow("integration 'ghost' not found");

		// Registered but without an account record: the unconfigured error names the configured services.
		const bare = defineIntegration({
			actions: { ping: { parameters: Type.Object({}), execute: async () => ({ ok: true }) } },
		});
		const integration = loadIntegrationFromDefinition(bare, "<bare>");
		const bareRunner = new IntegrationRunner(
			[integration],
			process.cwd(),
			IntegrationAccountStorage.inMemory({ heartbeat: {} }),
			IntegrationStore.inMemory(),
		);
		bareRunner.bindCore();
		expect(() => bareRunner.getIntegration("bare")).toThrow(
			"integration 'bare' is not configured (configured: heartbeat)",
		);

		await runner.stop();
	});
});

describe("firehose → workflow dispatch", () => {
	it("fans a validated emit into the workflow runner as a recorded run", async () => {
		const { heartbeat, runner, emit } = await startHeartbeatRunner();
		const backend: WorkflowAgentBackend = {
			cwd: "/agent-home",
			findSessions: async () => [],
			listSessions: async () => [],
			openSession: async (id) => {
				throw new Error(`no session '${id}'`);
			},
			createSession: async () => {
				throw new Error("no sessions in this test");
			},
		};

		const seen: Array<{ seq: number }> = [];
		const inbound = defineWorkflow({
			on: heartbeat.events.tick,
			async run(msg, ctx) {
				seen.push(msg);
				await ctx.integration(heartbeat).ping({ echo: `tick ${msg.seq}` });
			},
		});
		const workflowRunner = new WorkflowRunner([{ name: "inbound", path: "<inbound>", definition: inbound }], {
			backend,
			integrations: runner,
			generation: 1,
		});

		// The exact wiring buildSharedResources installs between the two runners.
		runner.onEvent((evt) => {
			void workflowRunner.dispatchIntegrationEvent(evt.service, evt.event, evt.data);
		});

		// Actions do not fire the firehose; only producer emits do.
		await runner.getIntegration("heartbeat").call("ping", { echo: "warm" });
		expect(workflowRunner.runs).toHaveLength(0);

		// No per-service `.on` listener anywhere — the firehose alone carries the event.
		emit("tick", { seq: 7 });

		await waitFor(() => workflowRunner.runs.length === 1 && seen.length === 1);
		expect(seen).toEqual([{ seq: 7 }]);
		const journal = workflowRunner.runs[0];
		expect(journal.records[0]).toMatchObject({
			type: "run_start",
			workflow: "inbound",
			trigger: { kind: "integration", service: "heartbeat", event: "tick", payload: { seq: 7 } },
		});
		const steps = journal.records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(steps.map((s) => s.name)).toEqual(["integration.call ping"]);
		await waitFor(() => journal.records.at(-1)?.type === "run_end");
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });

		await runner.stop();
	});
});
