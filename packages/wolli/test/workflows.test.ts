/**
 * Workflow-subsystem unit check: the authoring surface and the run journal.
 *
 * `defineWorkflow` is identity at runtime, so the value there is (a) `getWorkflowKind`
 * over all three trigger shapes, and (b) compile-time assertions
 * that handler payloads and ctx are typed per trigger kind — `pnpm typecheck` includes
 * test files, so the `expectTypeOf`/`@ts-expect-error` lines are gated.
 *
 * The RunJournal suite drives runs by hand (the runner arrives in a later step) and
 * asserts the record stream: ordering, checkpoint keying, nesting, error capture, the
 * serialization guard, and the per-run JSONL debug log.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	defineWorkflow,
	getWorkflowKind,
	type IntegrationEventDescriptor,
	type LifecycleWorkflowContext,
	type LifecycleWorkflowDefinition,
	RunJournal,
	type StepEndRecord,
	type StepStartRecord,
	type WorkflowContext,
	type WorkflowSession,
} from "../src/core/workflows/index.ts";

interface HeartbeatTick {
	seq: number;
	at: number;
}

/** Inline descriptor stand-in for what `defineIntegration` will mint in Phase 2. */
const tick: IntegrationEventDescriptor<HeartbeatTick> = {
	kind: "integration",
	service: "heartbeat",
	event: "tick",
};

describe("defineWorkflow", () => {
	it("is identity at runtime", () => {
		const definition: LifecycleWorkflowDefinition<"agent_start"> = {
			on: "agent_start",
			run() {},
		};
		expect(defineWorkflow(definition)).toBe(definition);
	});

	it("types an integration-event workflow from the descriptor and classifies it", () => {
		const workflow = defineWorkflow({
			on: tick,
			async run(msg, ctx) {
				expectTypeOf(msg).toEqualTypeOf<HeartbeatTick>();
				expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
				// @ts-expect-error integration-event runs have no producing session
				void ctx.session;
			},
		});

		expect(workflow.on).toBe(tick);
		expect(getWorkflowKind(workflow)).toBe("integration");
	});

	it("types a lifecycle workflow via AgentEventMap and classifies it", () => {
		const workflow = defineWorkflow({
			on: "turn_end",
			async run(evt, ctx) {
				expectTypeOf(evt.turnIndex).toEqualTypeOf<number>();
				expectTypeOf(evt.toolResults.length).toEqualTypeOf<number>();
				expectTypeOf(ctx).toEqualTypeOf<LifecycleWorkflowContext>();
				expectTypeOf(ctx.session).toEqualTypeOf<WorkflowSession>();
			},
		});

		expect(workflow.on).toBe("turn_end");
		expect(getWorkflowKind(workflow)).toBe("lifecycle");
	});

	it("types a callable workflow from its schemas and classifies it", () => {
		const workflow = defineWorkflow({
			input: Type.Object({ url: Type.String() }),
			output: Type.Object({ excerpt: Type.String() }),
			run(input, ctx) {
				expectTypeOf(input.url).toEqualTypeOf<string>();
				expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
				return { excerpt: input.url.slice(0, 8) };
			},
		});

		expect(getWorkflowKind(workflow)).toBe("callable");
	});
});

describe("RunJournal", () => {
	const trigger = {
		kind: "integration",
		service: "telegram",
		event: "message",
		payload: { chatId: 7, text: "hi" },
	} as const;

	it("records a run tree with nested and failed steps in order", async () => {
		const journal = new RunJournal({ workflow: "telegram-inbound", trigger, generation: 1 });

		const find = journal.startStep("agent.findSessions", { kind: "auto", args: { "telegram:chat": "7" } });
		journal.endStep(find, { status: "ok", result: [] });
		const deliver = journal.startStep("session.prompt", { kind: "auto", args: "hi" });
		const tool = journal.startStep("tool bash", { kind: "auto", parentStepId: deliver });
		journal.endStep(tool, { status: "ok", result: { exitCode: 0 } });
		journal.endStep(deliver, { status: "ok" });
		await expect(
			journal.step(
				"boom",
				() => {
					throw new Error("nope");
				},
				{ kind: "user" },
			),
		).rejects.toThrow("nope");
		journal.endRun("error", new Error("nope"));

		expect(journal.records.map((r) => r.type)).toEqual([
			"run_start",
			"step_start",
			"step_end",
			"step_start",
			"step_start",
			"step_end",
			"step_end",
			"step_start",
			"step_end",
			"run_end",
		]);

		const [start] = journal.records;
		expect(start).toMatchObject({
			type: "run_start",
			runId: journal.runId,
			workflow: "telegram-inbound",
			trigger,
			generation: 1,
		});
		expect(journal.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

		// The nested tool step carries its parent and is not a checkpoint candidate.
		const toolStart = journal.records.find(
			(r): r is StepStartRecord => r.type === "step_start" && r.name === "tool bash",
		);
		expect(toolStart).toMatchObject({ parentStepId: deliver, kind: "auto" });
		expect(toolStart?.checkpointKey).toBeUndefined();

		// The failed user step captures the three-field error shape; the run ends error.
		const boomEnd = journal.records.filter((r): r is StepEndRecord => r.type === "step_end").at(-1);
		expect(boomEnd).toMatchObject({ status: "error", attempt: 1, error: { name: "Error", message: "nope" } });
		expect(boomEnd?.error?.stack).toBeDefined();
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "error" });
		for (const record of journal.records) expect(typeof record.ts).toBe("number");
	});

	it("keys repeated top-level names with an occurrence counter that children do not feed", () => {
		const journal = new RunJournal({ workflow: "poller", trigger: { kind: "callable", input: {} }, generation: 1 });

		const first = journal.startStep("poll", { kind: "user" });
		journal.endStep(first, { status: "ok" });
		const second = journal.startStep("poll", { kind: "user" });
		const child = journal.startStep("poll", { kind: "auto", parentStepId: second });
		journal.endStep(child, { status: "ok" });
		journal.endStep(second, { status: "ok" });
		const third = journal.startStep("poll", { kind: "user" });
		journal.endStep(third, { status: "ok" });
		journal.endRun("ok");

		const keys = journal.records
			.filter((r): r is StepStartRecord => r.type === "step_start")
			.map((r) => r.checkpointKey);
		expect(keys).toEqual(["poll", "poll#2", undefined, "poll#3"]);
	});

	it("records an aborted run as cancelled", () => {
		const journal = new RunJournal({ workflow: "slow", trigger: { kind: "callable", input: {} }, generation: 1 });
		journal.endRun("cancelled");
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "cancelled" });
	});

	it("mirrors records to a per-run JSONL debug log that parses back identically", async () => {
		const runsDir = join(await mkdtemp(join(tmpdir(), "wolli-runs-")), "runs");
		const journal = new RunJournal({ workflow: "telegram-inbound", trigger, generation: 1, runsDir });
		await journal.step("compose", () => "ok", { kind: "user", args: { n: 1 } });
		journal.endRun("ok");
		await journal.flush();

		expect(await readdir(runsDir)).toEqual([`${journal.runId}.jsonl`]);
		const lines = (await readFile(join(runsDir, `${journal.runId}.jsonl`), "utf-8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual(journal.records);
	});

	it("degrades non-serializable values to the marker but returns the live value", async () => {
		const journal = new RunJournal({ workflow: "x", trigger: { kind: "callable", input: {} }, generation: 1 });

		const circular: { self?: unknown } = {};
		circular.self = circular;
		const result = await journal.step("make-circular", () => circular, { kind: "user" });
		expect(result).toBe(circular);

		const end = journal.records.at(-1) as StepEndRecord;
		expect(end.status).toBe("ok");
		expect(end.result).toEqual({ $unserializable: true, type: "Object" });

		const fn = await journal.step("make-fn", () => () => 1, { kind: "user" });
		expect(typeof fn).toBe("function");
		expect((journal.records.at(-1) as StepEndRecord).result).toEqual({ $unserializable: true, type: "function" });

		// A degraded trigger payload keeps the typed discriminant fields on run_start.
		const degraded = new RunJournal({
			workflow: "y",
			trigger: { kind: "integration", service: "s", event: "e", payload: circular },
			generation: 1,
		});
		expect(degraded.records[0]).toMatchObject({
			type: "run_start",
			trigger: { kind: "integration", service: "s", event: "e", payload: { $unserializable: true, type: "Object" } },
		});
	});
});
