/**
 * Hook unit check: the defineHook authoring surface.
 *
 * `defineHook` is identity at runtime, so the value is (a) that identity, and (b)
 * compile-time assertions that the `before:` literal narrows the handler's event and
 * result shapes and that ctx is the lifecycle workflow ctx (every hook event is
 * session-scoped) — `pnpm typecheck` includes test files, so the
 * `expectTypeOf`/`@ts-expect-error` lines are gated.
 *
 * The documented-surface suite pins the `before:` set at exactly the eight documented
 * literals, mirroring the AgentEventMap pin in workflows.test.ts.
 */

import type { AgentMessage } from "@opsyhq/agent";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	CustomToolCallEvent,
	CustomToolResultEvent,
	MessageEndEvent,
	SessionBeforeCompactEvent,
} from "../src/core/extensions/types.ts";
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
	defineHook,
	type Hook,
	type HookDefinition,
	type HookEventMap,
	type HookResultMap,
	type LifecycleWorkflowContext,
	type RunStartRecord,
	type StepStartRecord,
	type WorkflowAgentBackend,
	type WorkflowError,
	WorkflowRunner,
	type WorkflowSession,
} from "../src/core/workflows/index.ts";

describe("defineHook", () => {
	it("is identity at runtime", () => {
		const definition: HookDefinition<"tool_call"> = {
			before: "tool_call",
			run() {},
		};
		expect(defineHook(definition)).toBe(definition);
	});

	it("types a tool_call hook: the handler sees the tool-call event and can block", () => {
		const hook = defineHook({
			before: "tool_call",
			async run(evt, ctx) {
				expectTypeOf(evt.type).toEqualTypeOf<"tool_call">();
				expectTypeOf(evt.toolName).toEqualTypeOf<string>();
				expectTypeOf(ctx).toEqualTypeOf<LifecycleWorkflowContext>();
				expectTypeOf(ctx.session).toEqualTypeOf<WorkflowSession>();
				if (evt.toolName === "bash" && JSON.stringify(evt.input).includes("rm -rf")) {
					return { block: true, reason: "not allowed" };
				}
			},
		});

		expect(hook.before).toBe("tool_call");
	});

	it("types a message_end hook: the handler can replace the finalized message", () => {
		const hook = defineHook({
			before: "message_end",
			async run(evt) {
				expectTypeOf(evt.type).toEqualTypeOf<"message_end">();
				expectTypeOf(evt.message).toEqualTypeOf<AgentMessage>();
				return { message: evt.message };
			},
		});

		expect(hook.before).toBe("message_end");
	});

	it("accepts a handler that returns nothing: no interception", () => {
		const hook = defineHook({
			before: "input",
			run(evt) {
				expectTypeOf(evt.text).toEqualTypeOf<string>();
			},
		});

		expect(hook.before).toBe("input");
	});

	it("rejects observe-only lifecycle events: hooks bind before:, not on:", () => {
		defineHook({
			// @ts-expect-error "turn_end" is observe-only lifecycle surface, not one of the eight before: events
			before: "turn_end",
			run() {},
		});
	});
});

describe("documented surface", () => {
	it("pins the before: event set: a key added or renamed on either side fails typecheck", () => {
		expectTypeOf<keyof HookEventMap>().toEqualTypeOf<
			| "tool_call"
			| "tool_result"
			| "input"
			| "context"
			| "provider_request"
			| "agent_start"
			| "compact"
			| "message_end"
		>();
		expectTypeOf<keyof HookResultMap>().toEqualTypeOf<keyof HookEventMap>();
	});
});

// ============================================================================
// Hook chain dispatch (the runner's interception seam)
// ============================================================================

/** A real IntegrationRunner over an inline heartbeat integration — the runner constructor requires one. */
async function heartbeatIntegrationRunner(): Promise<IntegrationRunner> {
	const factory = (wolli: IntegrationsAPI) => {
		wolli.registerIntegration({
			name: "heartbeat",
			events: { tick: Type.Object({ seq: Type.Number() }) },
			actions: {},
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

/** A runner over hooks alone; ctx.agent is inert here — every hook event carries its own session. */
async function hookRunner(hooks: Hook[]): Promise<WorkflowRunner> {
	const backend: WorkflowAgentBackend = {
		cwd: "/agent-home",
		findSessions: async () => [],
		listSessions: async () => [],
		openSession: async (id) => {
			throw new Error(`no session '${id}'`);
		},
		createSession: async () => {
			throw new Error("no createSession");
		},
	};
	return new WorkflowRunner([], hooks, { backend, integrations: await heartbeatIntegrationRunner(), generation: 1 });
}

/** The producing session + dialog UI a hook run is scoped to: deliveries and notifications recorded. */
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

/** A loaded-hook wrapper around a definition — mirror of the loader's output. */
function hook<TEvent extends keyof HookEventMap>(name: string, definition: HookDefinition<TEvent>): Hook {
	return { name, path: `<${name}>`, definition: definition as HookDefinition<keyof HookEventMap> };
}

const userMessage = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

/** A custom-role message — the light way to get a different role than a user message for the role-guard check. */
const customMessage = (text: string): AgentMessage => ({
	role: "custom",
	customType: "note",
	content: text,
	display: true,
	timestamp: 0,
});

/** A custom-tool call event whose `input` is a plain record, so hooks can read/mutate arbitrary keys. */
const toolCallEvent = (command: string): CustomToolCallEvent => ({
	type: "tool_call",
	toolCallId: "t1",
	toolName: "custom",
	input: { command },
});

/** A custom-tool result event; `details` is unknown, so hooks patch it freely. */
const toolResultEvent = (): CustomToolResultEvent => ({
	type: "tool_result",
	toolCallId: "t1",
	toolName: "custom",
	input: {},
	content: [{ type: "text", text: "raw" }],
	isError: false,
	details: undefined,
});

/** A type-valid compaction event; hooks under test decide on it without reading its fields. */
function compactEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "e1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 0,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
		},
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

describe("WorkflowRunner hook dispatch", () => {
	it("runs tool_call hooks in array order over the same event: in-place input mutation reaches the caller", async () => {
		const seen: string[] = [];
		const runner = await hookRunner([
			hook("first", {
				before: "tool_call",
				run(evt) {
					const input = evt.input as Record<string, unknown>;
					seen.push(`first:${String(input.command)}`);
					input.command = "one";
				},
			}),
			hook("second", {
				before: "tool_call",
				run(evt) {
					// Sees the first hook's in-place mutation.
					const input = evt.input as Record<string, unknown>;
					seen.push(`second:${String(input.command)}`);
					input.command = "two";
				},
			}),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchToolCall(toolCallEvent("raw"), session, ui);

		expect(seen).toEqual(["first:raw", "second:one"]);
		expect(result).toBeUndefined();
	});

	it("preserves event identity: the mutated input lands on the caller's own event object", async () => {
		const runner = await hookRunner([
			hook("patch", {
				before: "tool_call",
				run(evt) {
					(evt.input as Record<string, unknown>).command = "patched";
				},
			}),
		]);
		const { session, ui } = stubProducingSession();
		const event = toolCallEvent("raw");

		await runner.dispatchToolCall(event, session, ui);

		expect(event.input.command).toBe("patched");
	});

	it("short-circuits tool_call on a block result: the later hook never runs", async () => {
		let secondRan = false;
		const runner = await hookRunner([
			hook("guard", {
				before: "tool_call",
				run() {
					return { block: true, reason: "denied" };
				},
			}),
			hook("after", {
				before: "tool_call",
				run() {
					secondRan = true;
				},
			}),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchToolCall(toolCallEvent("ls"), session, ui);

		expect(result).toEqual({ block: true, reason: "denied" });
		expect(secondRan).toBe(false);
	});

	it("patches tool_result across the chain and combines; an untouched chain returns undefined", async () => {
		const runner = await hookRunner([
			hook("mark-error", {
				before: "tool_result",
				run() {
					return { isError: true };
				},
			}),
			hook("rewrite", {
				before: "tool_result",
				run(evt) {
					// Sees the accumulated isError patch.
					expect(evt.isError).toBe(true);
					return { content: [{ type: "text" as const, text: "patched" }] };
				},
			}),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchToolResult(toolResultEvent(), session, ui);
		expect(result).toEqual({ content: [{ type: "text", text: "patched" }], details: undefined, isError: true });

		const quiet = await hookRunner([hook("noop", { before: "tool_result", run() {} })]);
		expect(await quiet.dispatchToolResult(toolResultEvent(), session, ui)).toBeUndefined();
	});

	it("threads input transforms, short-circuits on handled, and continues an untouched chain", async () => {
		const { session, ui } = stubProducingSession();

		const transform = await hookRunner([
			hook("upper", {
				before: "input",
				run: (evt) => ({ action: "transform" as const, text: `${evt.text}-a` }),
			}),
			hook("suffix", {
				before: "input",
				// Sees the first hook's transform.
				run: (evt) => ({ action: "transform" as const, text: `${evt.text}-b` }),
			}),
		]);
		expect(await transform.dispatchInput("hi", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "transform",
			text: "hi-a-b",
			images: undefined,
		});

		let secondRan = false;
		const handled = await hookRunner([
			hook("swallow", { before: "input", run: () => ({ action: "handled" as const }) }),
			hook("never", {
				before: "input",
				run() {
					secondRan = true;
				},
			}),
		]);
		expect(await handled.dispatchInput("hi", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "handled",
		});
		expect(secondRan).toBe(false);

		const quiet = await hookRunner([hook("noop", { before: "input", run() {} })]);
		expect(await quiet.dispatchInput("hi", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "continue",
		});
	});

	it("replaces context messages across the chain without mutating the caller's array", async () => {
		const runner = await hookRunner([
			hook("append-b", {
				before: "context",
				run: (evt) => ({ messages: [...evt.messages, userMessage("b")] }),
			}),
			hook("append-c", {
				before: "context",
				run: (evt) => ({ messages: [...evt.messages, userMessage("c")] }),
			}),
		]);
		const { session, ui } = stubProducingSession();
		const input = [userMessage("a")];

		const result = await runner.dispatchContext(input, session, ui);

		expect(result.map((m) => (m.role === "user" ? m.content : null))).toEqual(["a", "b", "c"]);
		// The caller's array is cloned at entry, never mutated.
		expect(input).toHaveLength(1);
	});

	it("threads the provider_request payload: each non-undefined return replaces it", async () => {
		const runner = await hookRunner([
			hook("stamp-1", { before: "provider_request", run: (evt) => `${String(evt.payload)}-1` }),
			hook("stamp-2", { before: "provider_request", run: (evt) => `${String(evt.payload)}-2` }),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchProviderRequest("p0", session, ui);

		expect(result).toBe("p0-1-2");
	});

	it("accumulates agent_start messages and lets the last systemPrompt win; no contribution returns undefined", async () => {
		let secondSawSystemPrompt: string | undefined;
		const runner = await hookRunner([
			hook("inject-1", {
				before: "agent_start",
				run() {
					return { message: { customType: "note", content: "one", display: true }, systemPrompt: "sp1" };
				},
			}),
			hook("inject-2", {
				before: "agent_start",
				run(evt) {
					secondSawSystemPrompt = evt.systemPrompt;
					return { message: { customType: "note", content: "two", display: true }, systemPrompt: "sp2" };
				},
			}),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchAgentStart("hi", undefined, "sp0", {}, session, ui);
		expect(secondSawSystemPrompt).toBe("sp1");
		expect(result?.systemPrompt).toBe("sp2");
		expect(result?.messages?.map((m) => m.content)).toEqual(["one", "two"]);

		const quiet = await hookRunner([hook("noop", { before: "agent_start", run() {} })]);
		expect(await quiet.dispatchAgentStart("hi", undefined, "sp0", {}, session, ui)).toBeUndefined();
	});

	it("short-circuits the compact chain on a cancel result", async () => {
		let secondRan = false;
		const runner = await hookRunner([
			hook("cancel", { before: "compact", run: () => ({ cancel: true }) }),
			hook("after", {
				before: "compact",
				run() {
					secondRan = true;
				},
			}),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchCompact(compactEvent(), session, ui);

		expect(result).toEqual({ cancel: true });
		expect(secondRan).toBe(false);
	});

	it("chains same-role message_end replacements and skips a role change with an error, continuing the chain", async () => {
		const runner = await hookRunner([
			hook("rewrite-1", { before: "message_end", run: () => ({ message: userMessage("v1") }) }),
			hook("role-change", { before: "message_end", run: () => ({ message: customMessage("nope") }) }),
			hook("rewrite-2", {
				before: "message_end",
				run(evt) {
					// Sees the surviving same-role replacement, not the rejected role change.
					expect(evt.message.role === "user" ? evt.message.content : null).toBe("v1");
					return { message: userMessage("v2") };
				},
			}),
		]);
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));
		const { session, ui } = stubProducingSession();
		const event: MessageEndEvent = { type: "message_end", message: userMessage("orig") };

		const result = await runner.dispatchMessageEnd(event, session, ui);

		expect(result && result.role === "user" ? result.content : null).toBe("v2");
		expect(errors).toEqual([
			{
				path: "<role-change>",
				event: "message_end",
				error: "message_end hooks must return a message with the same role",
			},
		]);
	});

	it("fails open when a tool_call hook throws: its run records error, the sink fires, the chain continues", async () => {
		const runner = await hookRunner([
			hook("boom", {
				before: "tool_call",
				run() {
					throw new Error("kaboom");
				},
			}),
			hook("recover", {
				before: "tool_call",
				run(evt) {
					(evt.input as Record<string, unknown>).command = "recovered";
				},
			}),
		]);
		const errors: WorkflowError[] = [];
		runner.onError((error) => errors.push(error));
		const { session, ui } = stubProducingSession();
		const event = toolCallEvent("raw");

		await runner.dispatchToolCall(event, session, ui);

		// The throwing hook's run is recorded as error (the normalization: today's emitToolCall has no try/catch).
		expect(runner.runs[0].records.at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			error: { name: "Error", message: "kaboom" },
		});
		expect(errors).toEqual([
			{
				path: "<boom>",
				event: "tool_call",
				error: "hook 'boom' failed: kaboom",
				stack: expect.stringContaining("kaboom"),
			},
		]);
		// The chain continued past the failure with the event as-is; the second hook still patched it.
		expect(event.input.command).toBe("recovered");
	});

	it("records every hook firing as a run with the hook trigger, its ctx.session, and the passed ctx.ui", async () => {
		const runner = await hookRunner([
			hook("greeter", {
				before: "input",
				async run(_evt, ctx) {
					await ctx.session.prompt("from hook");
					ctx.ui.notify(`hooked ${ctx.session.id}`);
				},
			}),
			hook("quiet", { before: "input", run() {} }),
		]);
		const { session, ui, deliveries, notifications } = stubProducingSession("live");

		await runner.dispatchInput("hi", undefined, "interactive", undefined, session, ui);

		// One recorded run per hook firing.
		expect(runner.runs).toHaveLength(2);
		expect(runner.runs.map((r) => (r.records[0] as RunStartRecord).workflow)).toEqual(["greeter", "quiet"]);
		for (const journal of runner.runs) {
			expect((journal.records[0] as RunStartRecord).trigger).toMatchObject({ kind: "hook", event: "input" });
		}
		// ctx.session.prompt recorded a delivery step in the greeter's own journal.
		const greeterSteps = runner.runs[0].records.filter((r): r is StepStartRecord => r.type === "step_start");
		expect(greeterSteps.map((s) => s.name)).toEqual(["session.prompt"]);
		expect(deliveries).toEqual(["from hook"]);
		// ctx.ui is the UI passed into dispatch.
		expect(notifications).toEqual(["hooked live"]);
	});

	it("reports hook presence via hasHooks", async () => {
		const runner = await hookRunner([hook("guard", { before: "tool_call", run() {} })]);

		expect(runner.hasHooks("tool_call")).toBe(true);
		expect(runner.hasHooks("input")).toBe(false);
	});
});
