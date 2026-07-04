/**
 * Workflow-subsystem unit check: the authoring surface and the run journal.
 *
 * `defineWorkflow` is identity at runtime, so the value there is (a) `getWorkflowKind`
 * over all three trigger shapes, and (b) compile-time assertions
 * that handler payloads and ctx are typed per trigger kind — `pnpm typecheck` includes
 * test files, so the `expectTypeOf`/`@ts-expect-error` lines are gated.
 *
 * The RunJournal suite drives runs by hand and asserts the record stream: ordering,
 * checkpoint keying, nesting, error capture, the serialization guard, and the per-run
 * JSONL debug log.
 *
 * The WorkflowRunner suite is the integrations suite's stance one level up: an in-memory
 * agent backend, a real IntegrationRunner over an inline heartbeat integration, and
 * inline defineWorkflow definitions — dispatch in, recorded run tree out.
 *
 * The lifecycle-dispatch suite drives dispatchLifecycle against a stub producing session
 * (scripted session + typed no-op dialog UI): typed events in, the gated
 * ctx.session/ctx.ui, and recorded deliveries out.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@opsyhq/agent";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	createIntegrationRuntime,
	IntegrationRunner,
	type IntegrationsAPI,
	loadIntegrationFromFactory,
} from "../src/core/integrations/index.ts";
import {
	type DialogUI,
	defineWorkflow,
	getWorkflowKind,
	type IntegrationEventDescriptor,
	type IntegrationKey,
	type LifecycleWorkflowContext,
	type LifecycleWorkflowDefinition,
	RunJournal,
	type StepEndRecord,
	type StepStartRecord,
	type WorkflowAgentBackend,
	type WorkflowContext,
	type WorkflowError,
	WorkflowRunner,
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

interface HeartbeatActions {
	ping(params: Record<string, never>): { ok: boolean };
}

/** Inline `ctx.integration` key stand-in for a Phase 2 `defineIntegration` default export. */
const heartbeat: IntegrationKey<HeartbeatActions> = { service: "heartbeat" };

/** A real IntegrationRunner over the inline heartbeat integration and in-memory stores. */
async function heartbeatIntegrationRunner(): Promise<IntegrationRunner> {
	const factory = (wolli: IntegrationsAPI) => {
		wolli.registerIntegration({
			name: "heartbeat",
			events: { tick: Type.Object({ seq: Type.Number(), at: Type.Number() }) },
			actions: {
				ping: {
					parameters: Type.Object({}),
					execute: async () => ({ ok: true }),
				},
			},
		});
	};
	const runtime = createIntegrationRuntime();
	const integration = await loadIntegrationFromFactory(factory, process.cwd(), runtime, "<heartbeat>");
	const runner = new IntegrationRunner(
		[integration],
		runtime,
		process.cwd(),
		IntegrationAccountStorage.inMemory({ heartbeat: { default: {} } }),
		IntegrationStore.inMemory(),
	);
	runner.bindCore();
	return runner;
}

interface StubSession {
	id: string;
	tags: Record<string, string>;
}

/** In-memory WorkflowAgentBackend over tag-bearing session stubs — no agent home, no chat turn. */
function memoryBackend() {
	const sessions: StubSession[] = [];
	const deliveries: Array<{ session: string; text: string }> = [];

	const toInfo = (session: StubSession) => ({ id: session.id, createdAt: "", tags: session.tags });
	const sessionFor = (session: StubSession): WorkflowSession => ({
		id: session.id,
		prompt: async (text) => {
			deliveries.push({ session: session.id, text });
		},
		sendUserMessage: async (content) => {
			deliveries.push({ session: session.id, text: String(content) });
		},
		getTags: () => ({ ...session.tags }),
		setTags: (tags) => {
			Object.assign(session.tags, tags);
		},
	});

	const backend: WorkflowAgentBackend = {
		cwd: "/agent-home",
		findSessions: async (filter) =>
			sessions.filter((s) => Object.entries(filter).every(([key, value]) => s.tags[key] === value)).map(toInfo),
		listSessions: async () => sessions.map(toInfo),
		openSession: async (id) => {
			const session = sessions.find((s) => s.id === id);
			if (!session) throw new Error(`no session '${id}'`);
			return sessionFor(session);
		},
		createSession: async () => {
			const session: StubSession = { id: `s${sessions.length + 1}`, tags: {} };
			sessions.push(session);
			return sessionFor(session);
		},
	};
	return { backend, deliveries };
}

/**
 * A producing session for lifecycle dispatch: a scripted session stub plus a DialogUI
 * stub in the IntegrationOnboardUI idiom — typed no-ops except notify, which records so
 * a test can assert ctx.ui reached it.
 */
function stubProducingSession(id = "live", tags: Record<string, string> = {}) {
	const deliveries: string[] = [];
	const notifications: string[] = [];
	const session: WorkflowSession = {
		id,
		prompt: async (text) => {
			deliveries.push(text);
		},
		sendUserMessage: async (content) => {
			deliveries.push(String(content));
		},
		getTags: () => ({ ...tags }),
		setTags: (next) => {
			Object.assign(tags, next);
		},
	};
	const ui: DialogUI = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => {
			notifications.push(message);
		},
	};
	return { session, ui, deliveries, notifications };
}

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
		account: "default",
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
			trigger: { kind: "integration", service: "s", account: "default", event: "e", payload: circular },
			generation: 1,
		});
		expect(degraded.records[0]).toMatchObject({
			type: "run_start",
			trigger: {
				kind: "integration",
				service: "s",
				account: "default",
				event: "e",
				payload: { $unserializable: true, type: "Object" },
			},
		});
	});
});

describe("WorkflowRunner", () => {
	it("dispatches an integration event and records the canonical run tree", async () => {
		const { backend, deliveries } = memoryBackend();
		const integrations = await heartbeatIntegrationRunner();

		// The docs' telegram-inbound shape: find the tagged session or create it, deliver, act.
		const inbound = defineWorkflow({
			on: tick,
			async run(msg, ctx) {
				expectTypeOf(msg).toEqualTypeOf<HeartbeatTick>();
				const chatTag = { "heartbeat:chat": String(msg.seq) };
				const [match] = await ctx.agent.findSessions(chatTag);
				const session = match ? await ctx.agent.openSession(match.id) : await ctx.agent.createSession();
				session.setTags(chatTag);
				await session.sendUserMessage(`tick ${msg.seq}`);
				const handle = ctx.integration(heartbeat);
				expectTypeOf(handle.ping).toEqualTypeOf<(params: Record<string, never>) => Promise<{ ok: boolean }>>();
				await handle.ping({});
			},
		});

		const runner = new WorkflowRunner(
			[{ name: "heartbeat-inbound", path: "<heartbeat-inbound>", definition: inbound }],
			{ backend, integrations, generation: 1 },
		);

		await runner.dispatchIntegrationEvent("heartbeat", "default", "tick", { seq: 7, at: 1 });

		expect(deliveries).toEqual([{ session: "s1", text: "tick 7" }]);
		expect(runner.runs).toHaveLength(1);
		const journal = runner.runs[0];
		expect(journal.records[0]).toMatchObject({
			type: "run_start",
			workflow: "heartbeat-inbound",
			trigger: {
				kind: "integration",
				service: "heartbeat",
				account: "default",
				event: "tick",
				payload: { seq: 7, at: 1 },
			},
			generation: 1,
		});
		const steps = journal.records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(steps.map((s) => s.name)).toEqual([
			"agent.findSessions",
			"agent.createSession",
			"session.sendUserMessage",
			"integration.call ping",
		]);
		expect(steps.every((s) => s.kind === "auto")).toBe(true);
		// The session-producing step records the id, not the live object.
		const createEnd = journal.records.find(
			(r): r is StepEndRecord => r.type === "step_end" && r.stepId === steps[1].stepId,
		);
		expect(createEnd?.result).toBe("s1");
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });

		// The same tag routes the next event to the existing session via openSession.
		await runner.dispatchIntegrationEvent("heartbeat", "default", "tick", { seq: 7, at: 2 });
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1].session).toBe("s1");
		const rerouted = runner.runs[1].records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(rerouted.map((s) => s.name)).toContain("agent.openSession");

		// An event nothing binds is a no-op.
		await runner.dispatchIntegrationEvent("heartbeat", "default", "nope", {});
		expect(runner.runs).toHaveLength(2);
	});

	it("invokes a callable by name, validating input and output at the boundary", async () => {
		const { backend } = memoryBackend();
		const excerpt = defineWorkflow({
			input: Type.Object({ url: Type.String() }),
			output: Type.Object({ excerpt: Type.String() }),
			run: (input) => ({ excerpt: input.url.slice(0, 4) }),
		});
		// Statically fine, invalid at runtime: output validation must fail the run.
		const shout = defineWorkflow({
			input: Type.Object({}),
			output: Type.String({ minLength: 5 }),
			run: () => "no",
		});
		const runner = new WorkflowRunner(
			[
				{ name: "excerpt", path: "<excerpt>", definition: excerpt },
				{ name: "shout", path: "<shout>", definition: shout },
			],
			{ backend, integrations: await heartbeatIntegrationRunner(), generation: 1 },
		);

		await expect(runner.invoke("excerpt", { url: "https://x" })).resolves.toEqual({ excerpt: "http" });
		expect(runner.runs).toHaveLength(1);
		expect(runner.runs[0].records[0]).toMatchObject({
			type: "run_start",
			workflow: "excerpt",
			trigger: { kind: "callable", input: { url: "https://x" } },
		});
		expect(runner.runs[0].records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });

		await expect(runner.invoke("nope", {})).rejects.toThrow("unknown callable workflow 'nope'");
		await expect(runner.invoke("excerpt", { url: 7 })).rejects.toThrow(/invalid input for workflow 'excerpt'/);
		expect(runner.runs).toHaveLength(1); // rejected input never opens a run

		await expect(runner.invoke("shout", {})).rejects.toThrow(/invalid output from workflow 'shout'/);
		expect(runner.runs[1].records.at(-1)).toMatchObject({ type: "run_end", status: "error" });
	});

	it("records a thrown handler as a failed run and surfaces it on the error sink", async () => {
		const { backend } = memoryBackend();
		const failing = defineWorkflow({
			on: tick,
			async run(_msg, ctx) {
				await ctx.step("before", () => "done");
				throw new Error("boom");
			},
		});
		const runner = new WorkflowRunner([{ name: "failing", path: "<failing>", definition: failing }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));

		// Dispatch resolves; the failure lands on the sink and in the record, not on the caller.
		await runner.dispatchIntegrationEvent("heartbeat", "default", "tick", { seq: 1, at: 1 });

		expect(errors).toEqual([
			{
				path: "<failing>",
				event: "heartbeat.tick",
				error: "workflow 'failing' failed: boom",
				stack: expect.stringContaining("boom"),
			},
		]);
		// The step that completed before the throw is preserved alongside the failure.
		expect(runner.runs[0].records).toMatchObject([
			{ type: "run_start" },
			{ type: "step_start", name: "before", kind: "user" },
			{ type: "step_end", status: "ok", result: "done" },
			{ type: "run_end", status: "error", error: { name: "Error", message: "boom" } },
		]);
	});

	it("stop() aborts in-flight runs, which end cancelled and stay off the error sink", async () => {
		const { backend } = memoryBackend();
		const hanging = defineWorkflow({
			on: tick,
			async run(_msg, ctx) {
				await ctx.step(
					"wait-forever",
					() =>
						new Promise((_resolve, reject) => {
							// A signal-respecting handler rejects with the abort reason.
							ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
						}),
				);
			},
		});
		const runner = new WorkflowRunner([{ name: "hanging", path: "<hanging>", definition: hanging }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));

		const dispatched = runner.dispatchIntegrationEvent("heartbeat", "default", "tick", { seq: 1, at: 1 });
		runner.stop();
		await dispatched;

		expect(runner.runs[0].records.at(-1)).toMatchObject({ type: "run_end", status: "cancelled" });
		expect(errors).toHaveLength(0);
	});
});

describe("WorkflowRunner lifecycle dispatch", () => {
	it("fires a bound workflow with the typed event, ctx.session, and ctx.ui", async () => {
		const { backend } = memoryBackend();
		const seenTags: Record<string, string>[] = [];
		// The docs' telegram-reply shape: read the producing session's tags, deliver, act.
		const reply = defineWorkflow({
			on: "agent_end",
			async run(evt, ctx) {
				expectTypeOf(evt.messages).toEqualTypeOf<AgentMessage[]>();
				expectTypeOf(ctx).toEqualTypeOf<LifecycleWorkflowContext>();
				seenTags.push(ctx.session.getTags());
				ctx.ui.notify(`replying to ${ctx.session.id}`);
				await ctx.session.sendUserMessage("digest sent");
				await ctx.integration(heartbeat).ping({});
			},
		});
		const runner = new WorkflowRunner([{ name: "reply", path: "<reply>", definition: reply }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});
		const { session, ui, deliveries, notifications } = stubProducingSession("live", { "telegram:chat": "7" });

		await runner.dispatchLifecycle({ type: "agent_end", messages: [] }, session, ui);

		expect(seenTags).toEqual([{ "telegram:chat": "7" }]);
		expect(notifications).toEqual(["replying to live"]);
		expect(deliveries).toEqual(["digest sent"]);
		expect(runner.runs).toHaveLength(1);
		const journal = runner.runs[0];
		expect(journal.records[0]).toMatchObject({
			type: "run_start",
			workflow: "reply",
			trigger: { kind: "lifecycle", event: "agent_end", payload: { type: "agent_end", messages: [] } },
			generation: 1,
		});
		// The producing-session delivery records as a step alongside the integration action.
		const steps = journal.records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(steps.map((s) => s.name)).toEqual(["session.sendUserMessage", "integration.call ping"]);
		expect(steps.every((s) => s.kind === "auto")).toBe(true);
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });
	});

	it("reports lifecycle trigger presence via hasTriggers", async () => {
		const { backend } = memoryBackend();
		const reply = defineWorkflow({ on: "agent_end", run() {} });
		const runner = new WorkflowRunner([{ name: "reply", path: "<reply>", definition: reply }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});

		expect(runner.hasTriggers("agent_end")).toBe(true);
		expect(runner.hasTriggers("message_update")).toBe(false);
	});

	it("is a no-op for a lifecycle event nothing binds", async () => {
		const { backend } = memoryBackend();
		const reply = defineWorkflow({ on: "agent_end", run() {} });
		const runner = new WorkflowRunner([{ name: "reply", path: "<reply>", definition: reply }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});

		const { session, ui } = stubProducingSession();
		await runner.dispatchLifecycle({ type: "session_start", reason: "new" }, session, ui);

		expect(runner.runs).toHaveLength(0);
	});

	it("records a thrown lifecycle handler as a failed run and surfaces it on the sink", async () => {
		const { backend } = memoryBackend();
		const failing = defineWorkflow({
			on: "session_start",
			async run() {
				throw new Error("kaput");
			},
		});
		const runner = new WorkflowRunner([{ name: "failing", path: "<failing>", definition: failing }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));

		// Dispatch resolves; the failure lands on the sink and in the record, not on the emitter.
		const { session, ui } = stubProducingSession();
		await runner.dispatchLifecycle({ type: "session_start", reason: "new" }, session, ui);

		expect(errors).toEqual([
			{
				path: "<failing>",
				event: "session_start",
				error: "workflow 'failing' failed: kaput",
				stack: expect.stringContaining("kaput"),
			},
		]);
		expect(runner.runs[0].records.at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			error: { name: "Error", message: "kaput" },
		});
	});

	it("keeps integration-event runs headless: no session or ui on ctx", async () => {
		const { backend } = memoryBackend();
		let sawSession: boolean | undefined;
		let sawUi: boolean | undefined;
		const inbound = defineWorkflow({
			on: tick,
			run(_msg, ctx) {
				sawSession = "session" in ctx;
				sawUi = "ui" in ctx;
			},
		});
		const runner = new WorkflowRunner([{ name: "inbound", path: "<inbound>", definition: inbound }], {
			backend,
			integrations: await heartbeatIntegrationRunner(),
			generation: 1,
		});

		await runner.dispatchIntegrationEvent("heartbeat", "default", "tick", { seq: 1, at: 1 });

		expect(sawSession).toBe(false);
		expect(sawUi).toBe(false);
	});
});
