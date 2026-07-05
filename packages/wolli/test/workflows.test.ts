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
 *
 * The loadWorkflows suite loads real fixture files from a temp workflows/ folder — the
 * first runtime proof that a value import from the bare "wolli" specifier resolves
 * through jiti when running from source.
 *
 * The documented-surface suite pins the docs/workflows.md tables at the type level (the
 * 14 lifecycle literals, the ctx/agent/session/ui key sets), and the doc-examples suite
 * loads the docs' workflow files verbatim (the Phase 2 defineIntegration import replaced
 * by a synthetic stand-in) and executes the named ones against the real runner.
 *
 * The AgentRuntime suite is the wiring proof, in the extensions-suite stance: a REAL
 * AgentRuntime in a temp agent home with a faux pi-ai provider. Workflows auto-discover
 * from <agentDir>/workflows/, session_start flows through the live event wiring with a
 * working ctx.session/ctx.ui, reload swaps the runner generation and picks up edited
 * code, failures ride the host error sink, and runs mirror to <agentDir>/runs/.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, type OAuthLoginCallbacks, registerFauxProvider } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@opsyhq/agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { noOpUIContext } from "../src/core/extensions/runner.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import { defineIntegration, IntegrationRunner, loadIntegrationFromDefinition } from "../src/core/integrations/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import {
	type AgentEventMap,
	type DialogUI,
	defineWorkflow,
	getWorkflowKind,
	type IntegrationEventDescriptor,
	type IntegrationKey,
	type LifecycleWorkflowContext,
	type LifecycleWorkflowDefinition,
	loadWorkflows,
	RunJournal,
	type StepEndRecord,
	type StepStartRecord,
	type WorkflowAgent,
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
function heartbeatIntegrationRunner(): IntegrationRunner {
	const definition = defineIntegration({
		events: { tick: Type.Object({ seq: Type.Number(), at: Type.Number() }) },
		actions: {
			ping: {
				parameters: Type.Object({}),
				execute: async () => ({ ok: true }),
			},
		},
	});
	const integration = loadIntegrationFromDefinition(definition, "<heartbeat>");
	const runner = new IntegrationRunner(
		[integration],
		process.cwd(),
		IntegrationAccountStorage.inMemory({ heartbeat: {} }),
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
		getSessionName: () => undefined,
		model: undefined,
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
		createSession: async (options) => {
			const session: StubSession = { id: `s${sessions.length + 1}`, tags: {} };
			sessions.push(session);
			// Honor setup so `createSession({ setup: (s) => s.appendTags(tag) })` binds the tag,
			// the way the real backend does — the channel-pattern tests route by it.
			if (options?.setup) {
				const manager = {
					appendTags: async (tags: Record<string, string>) => {
						Object.assign(session.tags, tags);
					},
				} as unknown as SessionManager;
				await options.setup(manager);
			}
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
		getSessionName: () => undefined,
		model: undefined,
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

describe("documented surface", () => {
	it("pins the docs/workflows.md name tables: a key added or renamed on either side fails typecheck", () => {
		// The complete lifecycle-event set — observe-only; none of the extension system's
		// mutating hook events (tool_call, context, input, before_agent_start, ...) belong here.
		expectTypeOf<keyof AgentEventMap>().toEqualTypeOf<
			| "session_start"
			| "session_shutdown"
			| "agent_start"
			| "agent_end"
			| "turn_start"
			| "turn_end"
			| "message_start"
			| "message_update"
			| "message_end"
			| "tool_execution_start"
			| "tool_execution_update"
			| "tool_execution_end"
			| "model_select"
			| "thinking_level_select"
		>();
		expectTypeOf<keyof WorkflowContext>().toEqualTypeOf<"agent" | "integration" | "step" | "signal">();
		expectTypeOf<keyof LifecycleWorkflowContext>().toEqualTypeOf<
			"agent" | "integration" | "step" | "signal" | "session" | "ui"
		>();
		expectTypeOf<keyof WorkflowAgent>().toEqualTypeOf<
			"findSessions" | "openSession" | "createSession" | "listSessions" | "cwd"
		>();
		// The docs' facade members plus the identity field session steps record.
		expectTypeOf<keyof WorkflowSession>().toEqualTypeOf<
			"id" | "prompt" | "sendUserMessage" | "getTags" | "setTags" | "getSessionName" | "model"
		>();
		expectTypeOf<keyof DialogUI>().toEqualTypeOf<"select" | "confirm" | "input" | "notify">();
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
			trigger: {
				kind: "integration",
				service: "s",
				event: "e",
				payload: { $unserializable: true, type: "Object" },
			},
		});
	});
});

describe("WorkflowRunner", () => {
	it("dispatches an integration event and records the canonical run tree", async () => {
		const { backend, deliveries } = memoryBackend();
		const integrations = heartbeatIntegrationRunner();

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

		await runner.dispatchIntegrationEvent("heartbeat", "tick", { seq: 7, at: 1 });

		expect(deliveries).toEqual([{ session: "s1", text: "tick 7" }]);
		expect(runner.runs).toHaveLength(1);
		const journal = runner.runs[0];
		expect(journal.records[0]).toMatchObject({
			type: "run_start",
			workflow: "heartbeat-inbound",
			trigger: {
				kind: "integration",
				service: "heartbeat",
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
		await runner.dispatchIntegrationEvent("heartbeat", "tick", { seq: 7, at: 2 });
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1].session).toBe("s1");
		const rerouted = runner.runs[1].records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(rerouted.map((s) => s.name)).toContain("agent.openSession");

		// An event nothing binds is a no-op.
		await runner.dispatchIntegrationEvent("heartbeat", "nope", {});
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
			{ backend, integrations: heartbeatIntegrationRunner(), generation: 1 },
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
			integrations: heartbeatIntegrationRunner(),
			generation: 1,
		});
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));

		// Dispatch resolves; the failure lands on the sink and in the record, not on the caller.
		await runner.dispatchIntegrationEvent("heartbeat", "tick", { seq: 1, at: 1 });

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
			integrations: heartbeatIntegrationRunner(),
			generation: 1,
		});
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));

		const dispatched = runner.dispatchIntegrationEvent("heartbeat", "tick", { seq: 1, at: 1 });
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
			integrations: heartbeatIntegrationRunner(),
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
			integrations: heartbeatIntegrationRunner(),
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
			integrations: heartbeatIntegrationRunner(),
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
			integrations: heartbeatIntegrationRunner(),
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
			integrations: heartbeatIntegrationRunner(),
			generation: 1,
		});

		await runner.dispatchIntegrationEvent("heartbeat", "tick", { seq: 1, at: 1 });

		expect(sawSession).toBe(false);
		expect(sawUi).toBe(false);
	});
});

async function writeWorkflowsDir(files: Record<string, string>): Promise<string> {
	const dir = join(await mkdtemp(join(tmpdir(), "wolli-workflows-")), "workflows");
	await mkdir(dir);
	for (const [name, source] of Object.entries(files)) {
		await writeFile(join(dir, name), source);
	}
	return dir;
}

describe("loadWorkflows", () => {
	it("loads one workflow per file: basename name, default-export definition, classified kind", async () => {
		const dir = await writeWorkflowsDir({
			// The bare "wolli" value import is the point: it must resolve through jiti.
			"on-agent-end.ts": `
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	on: "agent_end",
	async run() {},
});
`,
			"fetch-excerpt.ts": `
import { Type } from "typebox";
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	input: Type.Object({ url: Type.String() }),
	output: Type.Object({ excerpt: Type.String() }),
	run: (input) => ({ excerpt: input.url.slice(0, 4) }),
});
`,
			// Inline descriptor stand-in for a Phase 2 defineIntegration event.
			"heartbeat-inbound.ts": `
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	on: { kind: "integration", service: "heartbeat", event: "tick" },
	run() {},
});
`,
		});

		const result = await loadWorkflows(
			[join(dir, "on-agent-end.ts"), join(dir, "fetch-excerpt.ts"), join(dir, "heartbeat-inbound.ts")],
			dir,
		);

		expect(result.errors).toEqual([]);
		expect(result.workflows.map((w) => w.name)).toEqual(["on-agent-end", "fetch-excerpt", "heartbeat-inbound"]);
		expect(result.workflows.map((w) => getWorkflowKind(w.definition))).toEqual([
			"lifecycle",
			"callable",
			"integration",
		]);
		expect(result.workflows[0].path).toBe(join(dir, "on-agent-end.ts"));
		expect(result.workflows[0].definition).toMatchObject({ on: "agent_end" });
		expect(result.workflows[2].definition).toMatchObject({
			on: { kind: "integration", service: "heartbeat", event: "tick" },
		});
	});

	it("collects an error entry per bad file while good files still load", async () => {
		const dir = await writeWorkflowsDir({
			"good.ts": `
import { defineWorkflow } from "wolli";

export default defineWorkflow({ on: "agent_end", run() {} });
`,
			"no-default.ts": "export const nope = true;\n",
			"not-a-definition.ts": "export default 42;\n",
			"explodes.ts": 'throw new Error("kaboom at import");\n',
		});

		const result = await loadWorkflows(
			[
				join(dir, "good.ts"),
				join(dir, "no-default.ts"),
				join(dir, "not-a-definition.ts"),
				join(dir, "explodes.ts"),
				join(dir, "missing.ts"),
			],
			dir,
		);

		expect(result.workflows.map((w) => w.name)).toEqual(["good"]);
		expect(result.errors).toEqual([
			{
				path: join(dir, "no-default.ts"),
				error: expect.stringContaining("does not export a valid defineWorkflow definition"),
			},
			{
				path: join(dir, "not-a-definition.ts"),
				error: expect.stringContaining("does not export a valid defineWorkflow definition"),
			},
			{ path: join(dir, "explodes.ts"), error: expect.stringContaining("kaboom at import") },
			{ path: join(dir, "missing.ts"), error: expect.stringContaining("Failed to load workflow") },
		]);
	});

	it("yields no workflows and no errors for an empty workflows folder", async () => {
		// Discovery (plugin-manager, step 6) hands the loader the folder's file list; an
		// empty or missing workflows/ folder arrives as an empty path list.
		await expect(loadWorkflows([], "/agent-home")).resolves.toEqual({ workflows: [], errors: [] });
	});
});

describe("doc examples (docs/workflows.md)", () => {
	// The docs' workflow files, verbatim except that `import telegram from
	// "../integrations/telegram"` becomes an inline synthetic stand-in — the stand-in hardcodes
	// the `service: "telegram"` the integrations loader would stamp, and provides `.on`.
	const syntheticTelegram = `
// Synthetic stand-in for the telegram defineIntegration default export.
const telegram = {
	service: "telegram",
	events: { message: { kind: "integration", service: "telegram", event: "message" } },
	on(event, run) {
		return { on: this.events[event], run };
	},
};
`;
	const docFixtures: Record<string, string> = {
		"telegram-chat.ts": `
import { wolli } from "wolli";
${syntheticTelegram}
// msg is typed from the event schema
export const inbound = telegram.on("message", async (msg, ctx) => {
	const chatTag = { "telegram:chat": String(msg.chatId) };
	const [match] = await ctx.agent.findSessions(chatTag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({
				setup: (s) => s.appendTags(chatTag),
			});
	// followUp queues behind a running turn instead of interrupting it.
	await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
});

export const reply = wolli.on("agent_end", async (evt, ctx) => {
	const chat = ctx.session.getTags()["telegram:chat"];
	if (!chat) return; // not a telegram-bound session
	const text = evt.messages
		.filter((m) => m.role === "assistant")
		.at(-1)
		?.content.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!text) return; // a pure tool-call turn sends nothing
	await ctx.integration(telegram).sendMessage({ chatId: Number(chat), text });
});
`,
		"turn-metrics.ts": `
import { wolli } from "wolli";

// evt is typed via AgentEventMap
export default wolli.on("turn_end", async (evt, ctx) => {
	console.log(\`turn \${evt.turnIndex} ran \${evt.toolResults.length} tools\`);
});
`,
		"fetch-page.ts": `
import { defineWorkflow } from "wolli";
import { Type } from "typebox";

export default defineWorkflow({
	input: Type.Object({ url: Type.String() }),
	output: Type.Object({ excerpt: Type.String() }),
	async run(input) {
		const res = await fetch(input.url);
		return { excerpt: (await res.text()).slice(0, 500) };
	},
});
`,
		"greet-new-session.ts": `
import { wolli } from "wolli";
${syntheticTelegram}
export default wolli.on("session_start", async (evt, ctx) => {
	const chat = ctx.session.getTags()["telegram:chat"]; // the producing session
	if (!chat || evt.reason !== "new") return;
	const text = await ctx.step("compose-greeting", () => "Fresh session ready.");
	await ctx.integration(telegram).sendMessage({ chatId: Number(chat), text });
});
`,
	};

	async function loadDocWorkflow(fileName: string, workflowName?: string) {
		const dir = await writeWorkflowsDir({ [fileName]: docFixtures[fileName] });
		const result = await loadWorkflows([join(dir, fileName)], dir);
		expect(result.errors).toEqual([]);
		return workflowName ? result.workflows.find((w) => w.name === workflowName)! : result.workflows[0];
	}

	/** A real IntegrationRunner over the docs' telegram surface: a `message` event and a `sendMessage` action. */
	function telegramIntegrationRunner(sent: Array<{ chatId: number; text: string }>): IntegrationRunner {
		const definition = defineIntegration({
			events: { message: Type.Object({ chatId: Type.Number(), text: Type.String() }) },
			actions: {
				sendMessage: {
					parameters: Type.Object({ chatId: Type.Number(), text: Type.String() }),
					// Params reached execute through callAction's schema validation, so the cast is sound.
					execute: async (params: unknown) => {
						sent.push(params as { chatId: number; text: string });
						return { ok: true };
					},
				},
			},
		});
		const integration = loadIntegrationFromDefinition(definition, "<telegram>");
		const runner = new IntegrationRunner(
			[integration],
			process.cwd(),
			IntegrationAccountStorage.inMemory({ telegram: {} }),
			IntegrationStore.inMemory(),
		);
		runner.bindCore();
		return runner;
	}

	it("loads every documented workflow file with the documented name and kind", async () => {
		const dir = await writeWorkflowsDir(docFixtures);
		const result = await loadWorkflows(
			Object.keys(docFixtures).map((name) => join(dir, name)),
			dir,
		);

		expect(result.errors).toEqual([]);
		expect(result.workflows.map((w) => [w.name, getWorkflowKind(w.definition)])).toEqual([
			["inbound", "integration"],
			["reply", "lifecycle"],
			["turn-metrics", "lifecycle"],
			["fetch-page", "callable"],
			["greet-new-session", "lifecycle"],
		]);
	});

	it("inbound routes a message into a fresh session, recording the docs' run tree", async () => {
		const workflow = await loadDocWorkflow("telegram-chat.ts", "inbound");
		const { backend, deliveries } = memoryBackend();
		const runner = new WorkflowRunner([workflow], {
			backend,
			integrations: telegramIntegrationRunner([]),
			generation: 1,
		});

		await runner.dispatchIntegrationEvent("telegram", "message", { chatId: 7, text: "hi" });

		expect(deliveries).toEqual([{ session: "s1", text: "hi" }]);
		const journal = runner.runs[0];
		const steps = journal.records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(steps.map((s) => s.name)).toEqual([
			"agent.findSessions",
			"agent.createSession",
			"session.sendUserMessage",
		]);
		expect(steps.every((s) => s.kind === "auto")).toBe(true);
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });
	});

	it("greet-new-session greets a telegram-tagged new session and honors the reason guard", async () => {
		const workflow = await loadDocWorkflow("greet-new-session.ts");
		const sent: Array<{ chatId: number; text: string }> = [];
		const { backend } = memoryBackend();
		const runner = new WorkflowRunner([workflow], {
			backend,
			integrations: telegramIntegrationRunner(sent),
			generation: 1,
		});
		const { session, ui } = stubProducingSession("live", { "telegram:chat": "7" });

		await runner.dispatchLifecycle({ type: "session_start", reason: "new" }, session, ui);

		expect(sent).toEqual([{ chatId: 7, text: "Fresh session ready." }]);
		expect(runner.runs[0].records.filter((r): r is StepStartRecord => r.type === "step_start")).toMatchObject([
			{ name: "compose-greeting", kind: "user" },
			{ name: "integration.call sendMessage", kind: "auto" },
		]);
		expect(runner.runs[0].records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });

		// The documented guard: a non-"new" start greets nothing.
		await runner.dispatchLifecycle({ type: "session_start", reason: "reload" }, session, ui);
		expect(sent).toHaveLength(1);
		expect(runner.runs[1].records.filter((r) => r.type === "step_start")).toHaveLength(0);
	});

	it("turn-metrics observes a turn_end event and completes cleanly", async () => {
		const workflow = await loadDocWorkflow("turn-metrics.ts");
		const { backend } = memoryBackend();
		const runner = new WorkflowRunner([workflow], {
			backend,
			integrations: telegramIntegrationRunner([]),
			generation: 1,
		});
		const { session, ui } = stubProducingSession();

		await runner.dispatchLifecycle(
			{ type: "turn_end", turnIndex: 2, message: { role: "user", content: "hi", timestamp: 0 }, toolResults: [] },
			session,
			ui,
		);

		expect(runner.runs[0].records[0]).toMatchObject({
			type: "run_start",
			workflow: "turn-metrics",
			trigger: { kind: "lifecycle", event: "turn_end" },
		});
		expect(runner.runs[0].records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });
	});
});

describe("channel patterns (built-in telegram/scheduler shape)", () => {
	// A synthetic telegram integration + runner recording sends and typing toggles — the
	// contract the built-in telegram workflows drive. index.ts is grammY-bound and its deps
	// are not installed in-repo, so the pattern is proven against this stand-in (the manifest
	// smoke test gates the real files' existence and manifest keys).
	function telegramSetup() {
		const sent: Array<{ chatId: number; text: string }> = [];
		const typing: Array<{ action: "start" | "stop"; chatId: number }> = [];
		const telegram = defineIntegration({
			account: Type.Object({}),
			events: { message: Type.Object({ chatId: Type.Number(), text: Type.String() }) },
			actions: {
				sendMessage: {
					parameters: Type.Object({ chatId: Type.Number(), text: Type.String() }),
					execute: async (params: unknown) => {
						sent.push(params as { chatId: number; text: string });
						return { ok: true };
					},
				},
				startTyping: {
					parameters: Type.Object({ chatId: Type.Number() }),
					execute: async (params: unknown) => {
						typing.push({ action: "start", chatId: (params as { chatId: number }).chatId });
						return { ok: true };
					},
				},
				stopTyping: {
					parameters: Type.Object({ chatId: Type.Number() }),
					execute: async (params: unknown) => {
						typing.push({ action: "stop", chatId: (params as { chatId: number }).chatId });
						return { ok: true };
					},
				},
			},
		});
		const runner = new IntegrationRunner(
			[loadIntegrationFromDefinition(telegram, "<telegram>")],
			process.cwd(),
			IntegrationAccountStorage.inMemory({ telegram: {} }),
			IntegrationStore.inMemory(),
		);
		runner.bindCore();
		return { telegram, runner, sent, typing };
	}

	const noopUI: DialogUI = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	};

	const assistantTurn = (text: string): AgentMessage[] =>
		[{ role: "assistant", content: [{ type: "text", text }] }] as unknown as AgentMessage[];

	// The built-in reply's text extraction, structurally over the message shape (AgentMessage
	// is a wide union; the tag-routing is the point, not the exact message type).
	const finalAssistantText = (messages: AgentMessage[]): string => {
		const msgs = messages as unknown as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
		const last = msgs.filter((m) => m.role === "assistant").at(-1);
		return (
			last?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? ""
		).trim();
	};

	it("inbound creates a tag-bound session, reuses it on the next message, delivers followUp", async () => {
		const { backend, deliveries } = memoryBackend();
		const { telegram, runner: integrations } = telegramSetup();
		const inbound = defineWorkflow({
			on: telegram.events.message,
			async run(msg, ctx) {
				if (msg.text.startsWith("/")) return;
				const chatTag = { "telegram:chat": String(msg.chatId) };
				const [match] = await ctx.agent.findSessions(chatTag);
				const session = match
					? await ctx.agent.openSession(match.id)
					: await ctx.agent.createSession({
							setup: async (s) => {
								await s.appendTags(chatTag);
							},
						});
				await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
			},
		});
		const runner = new WorkflowRunner(
			[{ name: "telegram-inbound", path: "<telegram-inbound>", definition: inbound }],
			{
				backend,
				integrations,
				generation: 1,
			},
		);

		await runner.dispatchIntegrationEvent("telegram", "message", { chatId: 7, text: "hi" });
		await runner.dispatchIntegrationEvent("telegram", "message", { chatId: 7, text: "again" });

		expect(deliveries).toEqual([
			{ session: "s1", text: "hi" },
			{ session: "s1", text: "again" },
		]);
		// The second run reused the session via openSession — no second create.
		const second = runner.runs[1].records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(second.map((s) => s.name)).toEqual(["agent.findSessions", "agent.openSession", "session.sendUserMessage"]);
	});

	it("a /command short-circuits: no session prompt, the reply is sent through the integration", async () => {
		const { backend, deliveries } = memoryBackend();
		const { telegram, runner: integrations, sent } = telegramSetup();
		const inbound = defineWorkflow({
			on: telegram.events.message,
			async run(msg, ctx) {
				if (msg.text.startsWith("/")) {
					const command = msg.text.slice(1).split(/\s+/)[0].toLowerCase();
					if (command === "help") {
						await ctx
							.integration(telegram)
							.sendMessage({ chatId: msg.chatId, text: "Commands: /new /status /help" });
					}
					return;
				}
				const chatTag = { "telegram:chat": String(msg.chatId) };
				const [match] = await ctx.agent.findSessions(chatTag);
				const session = match
					? await ctx.agent.openSession(match.id)
					: await ctx.agent.createSession({
							setup: async (s) => {
								await s.appendTags(chatTag);
							},
						});
				await session.sendUserMessage(msg.text, { deliverAs: "followUp" });
			},
		});
		const runner = new WorkflowRunner(
			[{ name: "telegram-inbound", path: "<telegram-inbound>", definition: inbound }],
			{
				backend,
				integrations,
				generation: 1,
			},
		);

		await runner.dispatchIntegrationEvent("telegram", "message", { chatId: 7, text: "/help" });

		expect(deliveries).toEqual([]); // no session prompt
		expect(sent).toEqual([{ chatId: 7, text: "Commands: /new /status /help" }]);
	});

	it("agent_end reply sends the final text (stopping typing first), and does nothing for untagged or empty turns", async () => {
		const { backend } = memoryBackend();
		const { telegram, runner: integrations, sent, typing } = telegramSetup();
		const reply = defineWorkflow({
			on: "agent_end",
			async run(evt, ctx) {
				const chat = ctx.session.getTags()["telegram:chat"];
				if (!chat) return;
				const chatId = Number(chat);
				await ctx.integration(telegram).stopTyping({ chatId });
				const text = finalAssistantText(evt.messages);
				if (!text) return;
				await ctx.integration(telegram).sendMessage({ chatId, text });
			},
		});
		const runner = new WorkflowRunner([{ name: "telegram-reply", path: "<telegram-reply>", definition: reply }], {
			backend,
			integrations,
			generation: 1,
		});

		// Tagged session with final text: typing stops, then the reply is sent.
		const tagged = stubProducingSession("s-tag", { "telegram:chat": "7" });
		await runner.dispatchLifecycle({ type: "agent_end", messages: assistantTurn("done") }, tagged.session, tagged.ui);
		expect(typing).toEqual([{ action: "stop", chatId: 7 }]);
		expect(sent).toEqual([{ chatId: 7, text: "done" }]);

		// Untagged session: nothing at all — the tag guard returns before touching the integration.
		const untagged = stubProducingSession("s-plain", {});
		await runner.dispatchLifecycle(
			{ type: "agent_end", messages: assistantTurn("ignored") },
			untagged.session,
			untagged.ui,
		);
		expect(typing).toEqual([{ action: "stop", chatId: 7 }]);
		expect(sent).toHaveLength(1);

		// Tagged but empty (pure tool-call) turn: typing stops, nothing is sent.
		const empty = stubProducingSession("s-empty", { "telegram:chat": "9" });
		await runner.dispatchLifecycle({ type: "agent_end", messages: [] }, empty.session, empty.ui);
		expect(typing).toEqual([
			{ action: "stop", chatId: 7 },
			{ action: "stop", chatId: 9 },
		]);
		expect(sent).toHaveLength(1);
	});

	it("scheduler due routes the prompt to the origin-tagged session, creating a tagged one when absent", async () => {
		const { backend, deliveries } = memoryBackend();
		const scheduler = defineIntegration({
			account: Type.Object({}),
			events: {
				due: Type.Object({
					id: Type.String(),
					prompt: Type.String(),
					originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
					name: Type.Optional(Type.String()),
				}),
			},
		});
		const integrations = new IntegrationRunner(
			[loadIntegrationFromDefinition(scheduler, "<scheduler>")],
			process.cwd(),
			IntegrationAccountStorage.inMemory({ scheduler: {} }),
			IntegrationStore.inMemory(),
		);
		integrations.bindCore();
		const due = defineWorkflow({
			on: scheduler.events.due,
			async run(job, ctx) {
				const originTags = job.originTags ?? {};
				const [match] = await ctx.agent.findSessions(originTags);
				const session = match
					? await ctx.agent.openSession(match.id)
					: await ctx.agent.createSession({
							setup: async (s) => {
								await s.appendTags(originTags);
							},
						});
				await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
			},
		});
		const runner = new WorkflowRunner([{ name: "scheduler-due", path: "<scheduler-due>", definition: due }], {
			backend,
			integrations,
			generation: 1,
		});

		// No matching session: one is created carrying the origin tags.
		await runner.dispatchIntegrationEvent("scheduler", "due", {
			id: "j1",
			prompt: "digest",
			originTags: { "telegram:chat": "7" },
		});
		expect(deliveries).toEqual([{ session: "s1", text: "digest" }]);

		// A second due for the same origin reuses that session.
		await runner.dispatchIntegrationEvent("scheduler", "due", {
			id: "j1",
			prompt: "again",
			originTags: { "telegram:chat": "7" },
		});
		expect(deliveries).toEqual([
			{ session: "s1", text: "digest" },
			{ session: "s1", text: "again" },
		]);
	});

	it("composes across integrations: a due into a telegram-tagged session fires the telegram reply", async () => {
		const { backend } = memoryBackend();
		const { telegram, runner: integrations, sent } = telegramSetup();
		const scheduler = defineIntegration({
			account: Type.Object({}),
			events: {
				due: Type.Object({
					id: Type.String(),
					prompt: Type.String(),
					originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
			},
		});
		// Stamp the descriptor so its trigger key resolves; the scheduler needs no producer here.
		loadIntegrationFromDefinition(scheduler, "<scheduler>");
		const due = defineWorkflow({
			on: scheduler.events.due,
			async run(job, ctx) {
				const originTags = job.originTags ?? {};
				const [match] = await ctx.agent.findSessions(originTags);
				const session = match
					? await ctx.agent.openSession(match.id)
					: await ctx.agent.createSession({
							setup: async (s) => {
								await s.appendTags(originTags);
							},
						});
				await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
			},
		});
		const reply = defineWorkflow({
			on: "agent_end",
			async run(evt, ctx) {
				const chat = ctx.session.getTags()["telegram:chat"];
				if (!chat) return;
				const chatId = Number(chat);
				await ctx.integration(telegram).stopTyping({ chatId });
				const text = finalAssistantText(evt.messages);
				if (!text) return;
				await ctx.integration(telegram).sendMessage({ chatId, text });
			},
		});
		const runner = new WorkflowRunner(
			[
				{ name: "scheduler-due", path: "<scheduler-due>", definition: due },
				{ name: "telegram-reply", path: "<telegram-reply>", definition: reply },
			],
			{ backend, integrations, generation: 1 },
		);

		// The scheduler fires: its prompt lands in a fresh session carrying the telegram tag.
		await runner.dispatchIntegrationEvent("scheduler", "due", {
			id: "j1",
			prompt: "daily digest",
			originTags: { "telegram:chat": "7" },
		});

		// That session's turn ends: the reply rides its tag back to chat 7. Neither workflow
		// references the other — the tag the scheduler set is the whole contract.
		const woken = await backend.openSession("s1");
		await runner.dispatchLifecycle(
			{ type: "agent_end", messages: assistantTurn("here is your digest") },
			woken,
			noopUI,
		);

		expect(sent).toEqual([{ chatId: 7, text: "here is your digest" }]);
	});
});

describe("AgentRuntime workflow wiring", () => {
	const AGENT = "flowsmith";
	let home: string;
	let sharedDir: string;
	let markerDir: string;
	const registrations: Array<{ unregister(): void }> = [];

	/** The daemon→client login seam is unused here; the callbacks just have to exist. */
	const inertLoginCallbacks: OAuthLoginCallbacks = {
		onAuth: () => {},
		onDeviceCode: () => {},
		onProgress: () => {},
		onPrompt: async () => "",
		onManualCodeInput: async () => "",
		onSelect: async () => undefined,
	};

	// Loaded by jiti at runtime (never typechecked by this suite), so it reads its marker
	// dir from the env each call. Writes what it saw of the typed event and the gated
	// ctx.session/ctx.ui, and records a user step.
	const greetSource = (greeting: string) => `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	on: "session_start",
	async run(evt, ctx) {
		const text = await ctx.step("compose", () => "${greeting}");
		ctx.ui.notify("greeted " + ctx.session.id);
		writeFileSync(
			join(process.env.WOLLI_TEST_MARKER_DIR ?? ".", "workflow-run.json"),
			JSON.stringify({ reason: evt.reason, sessionId: ctx.session.id, tags: ctx.session.getTags(), text }),
		);
	},
});
`;

	function makeRuntime(): AgentRuntime {
		const registration = registerFauxProvider();
		registrations.push(registration);
		// Faux models are typed Model<string>; the runtime wants Model<Api> (Api is a
		// string supertype) — the cast bridges the faux test double to the real shape.
		const model = registration.getModel() as unknown as Model<Api>;
		const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
		return new AgentRuntime({
			name: AGENT,
			model,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage),
			integrationAccounts: IntegrationAccountStorage.inMemory(),
			integrationStore: IntegrationStore.inMemory(),
		});
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "wolli-wf-home-"));
		sharedDir = mkdtempSync(join(tmpdir(), "wolli-wf-shared-"));
		markerDir = mkdtempSync(join(tmpdir(), "wolli-wf-marker-"));
		process.env.WOLLI_HOME = home;
		process.env.WOLLI_SHARED_DIR = sharedDir;
		process.env.WOLLI_TEST_MARKER_DIR = markerDir;
		AgentSettingsManager.createAgent({ name: AGENT });
		mkdirSync(join(getAgentDir(AGENT), "workflows"), { recursive: true });
	});

	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
		delete process.env.WOLLI_HOME;
		delete process.env.WOLLI_SHARED_DIR;
		delete process.env.WOLLI_TEST_MARKER_DIR;
		rmSync(home, { recursive: true, force: true });
		rmSync(sharedDir, { recursive: true, force: true });
		rmSync(markerDir, { recursive: true, force: true });
	});

	it("auto-discovers workflows/ and dispatches session_start with a live ctx.session and ctx.ui", async () => {
		const agentDir = getAgentDir(AGENT);
		writeFileSync(join(agentDir, "workflows", "greet-new-session.ts"), greetSource("hello v1"), "utf-8");
		writeFileSync(
			join(agentDir, "workflows", "shout.ts"),
			`
import { Type } from "typebox";
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ text: Type.String() }),
	run: (input) => ({ text: input.text.toUpperCase() }),
});
`,
			"utf-8",
		);

		const runtime = makeRuntime();
		const notifications: string[] = [];
		runtime.bindInteractiveContext({
			createSessionUI: () => ({
				...noOpUIContext,
				notify: (message) => {
					notifications.push(message);
				},
			}),
			createLoginCallbacks: () => inertLoginCallbacks,
			mode: "print",
		});
		await runtime.start();

		const session = await runtime.createSession({
			setup: async (sessionManager) => {
				await sessionManager.appendTags({ "telegram:chat": "7" });
			},
		});

		// The handler saw the typed event and the producing session (id, tags) plus its UI rail.
		const marker = JSON.parse(readFileSync(join(markerDir, "workflow-run.json"), "utf-8"));
		expect(marker).toEqual({
			reason: "new",
			sessionId: session.getSessionId(),
			tags: { "telegram:chat": "7" },
			text: "hello v1",
		});
		expect(notifications).toEqual([`greeted ${session.getSessionId()}`]);

		// The run recorded on the live runner: generation 1, the user step, a clean end.
		const workflowRunner = runtime.workflowRunner;
		expect(workflowRunner).toBeDefined();
		expect(workflowRunner?.runs).toHaveLength(1);
		const journal = workflowRunner!.runs[0];
		expect(journal.records[0]).toMatchObject({
			type: "run_start",
			workflow: "greet-new-session",
			generation: 1,
			trigger: { kind: "lifecycle", event: "session_start", payload: { type: "session_start", reason: "new" } },
		});
		expect(journal.records[1]).toMatchObject({ type: "step_start", name: "compose", kind: "user" });
		expect(journal.records.at(-1)).toMatchObject({ type: "run_end", status: "ok" });

		// The run mirrored to <agentDir>/runs/<runId>.jsonl and parses back identically.
		await journal.flush();
		const lines = readFileSync(join(agentDir, "runs", `${journal.runId}.jsonl`), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual(journal.records);

		// The discovered callable fixture is reachable by name on the same runner.
		await expect(workflowRunner!.invoke("shout", { text: "hi" })).resolves.toEqual({ text: "HI" });
		await runtime.cleanup();
	});

	it("reload swaps the runner generation and runs the edited workflow code", async () => {
		const workflowPath = join(getAgentDir(AGENT), "workflows", "greet-new-session.ts");
		writeFileSync(workflowPath, greetSource("v1"), "utf-8");
		const runtime = makeRuntime();
		await runtime.start();
		const firstRunner = runtime.workflowRunner;

		await runtime.createSession();
		expect(JSON.parse(readFileSync(join(markerDir, "workflow-run.json"), "utf-8"))).toMatchObject({
			reason: "new",
			text: "v1",
		});
		expect(firstRunner?.runs[0].records[0]).toMatchObject({ generation: 1 });

		// Edit the file on disk; the rebuilt runner must load the NEW code (fresh jiti per
		// file, no module cache), and reload re-emits session_start on the resident session.
		writeFileSync(workflowPath, greetSource("v2"), "utf-8");
		await runtime.reload();

		const secondRunner = runtime.workflowRunner;
		expect(secondRunner).toBeDefined();
		expect(secondRunner).not.toBe(firstRunner);
		expect(JSON.parse(readFileSync(join(markerDir, "workflow-run.json"), "utf-8"))).toMatchObject({
			reason: "reload",
			text: "v2",
		});
		expect(secondRunner?.runs[0].records[0]).toMatchObject({ generation: 2 });
		// The reload-fired run landed only on the new generation; the old records stay put.
		expect(firstRunner?.runs).toHaveLength(1);
		await runtime.cleanup();
	});

	it("routes run failures to the host error sink and load failures to the resource summary", async () => {
		const workflowsDir = join(getAgentDir(AGENT), "workflows");
		writeFileSync(
			join(workflowsDir, "kaput.ts"),
			`
import { defineWorkflow } from "wolli";

export default defineWorkflow({
	on: "session_start",
	run() {
		throw new Error("kaput by design");
	},
});
`,
			"utf-8",
		);
		writeFileSync(join(workflowsDir, "no-default.ts"), "export const nope = true;\n", "utf-8");

		const runtime = makeRuntime();
		const errors: WorkflowError[] = [];
		runtime.bindInteractiveContext({
			createSessionUI: () => noOpUIContext,
			createLoginCallbacks: () => inertLoginCallbacks,
			mode: "print",
			onError: (error) => {
				errors.push(error);
			},
		});
		await runtime.start();

		// The unloadable file surfaces as a diagnostic beside extension/integration load errors.
		const summary = runtime.getResourceSummary();
		expect(
			summary.diagnostics.some(
				(d) => d.type === "error" && d.path?.endsWith("no-default.ts") && d.message.includes("defineWorkflow"),
			),
		).toBe(true);

		// The failed run lands on the same host error sink extensions and integrations use.
		await runtime.createSession();
		expect(errors).toEqual([
			expect.objectContaining({
				path: expect.stringContaining("kaput.ts"),
				event: "session_start",
				error: "workflow 'kaput' failed: kaput by design",
			}),
		]);
		await runtime.cleanup();
	});
});
