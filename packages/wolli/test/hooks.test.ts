/**
 * Hook unit check: the defineHook authoring surface.
 *
 * `defineHook` is identity at runtime, so the value is (a) that identity, and (b)
 * compile-time assertions that the `before:` literal narrows the handler's event and
 * result shapes and that ctx is the hook context (every hook event is session-scoped) —
 * `pnpm typecheck` includes test files, so the `expectTypeOf`/`@ts-expect-error` lines are
 * gated.
 *
 * The documented-surface suite pins the `before:` set at exactly the eight documented
 * literals, mirroring the AgentEventMap pin in workflows.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@opsyhq/agent";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	CustomToolCallEvent,
	CustomToolResultEvent,
	MessageEndEvent,
	SessionBeforeCompactEvent,
} from "../src/core/extensions/types.ts";
import {
	defineHook,
	type Hook,
	type HookContext,
	type HookDefinition,
	type HookError,
	type HookEventMap,
	type HookResultMap,
	HookRunner,
	loadHooks,
} from "../src/core/hooks/index.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { DialogUI, WorkflowSession } from "../src/core/workflows/index.ts";

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
				expectTypeOf(ctx).toEqualTypeOf<HookContext>();
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

/** The producing session + dialog UI a hook is scoped to: deliveries and notifications captured. */
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

describe("HookRunner dispatch", () => {
	it("runs tool_call hooks in array order over the same event: in-place input mutation reaches the caller", async () => {
		const seen: string[] = [];
		const runner = new HookRunner([
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
		const runner = new HookRunner([
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
		const runner = new HookRunner([
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
		const runner = new HookRunner([
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

		const quiet = new HookRunner([hook("noop", { before: "tool_result", run() {} })]);
		expect(await quiet.dispatchToolResult(toolResultEvent(), session, ui)).toBeUndefined();
	});

	it("threads input transforms, short-circuits on handled, and continues an untouched chain", async () => {
		const { session, ui } = stubProducingSession();

		const transform = new HookRunner([
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
		const handled = new HookRunner([
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

		const quiet = new HookRunner([hook("noop", { before: "input", run() {} })]);
		expect(await quiet.dispatchInput("hi", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "continue",
		});
	});

	it("replaces context messages across the chain without mutating the caller's array", async () => {
		const runner = new HookRunner([
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
		const runner = new HookRunner([
			hook("stamp-1", { before: "provider_request", run: (evt) => `${String(evt.payload)}-1` }),
			hook("stamp-2", { before: "provider_request", run: (evt) => `${String(evt.payload)}-2` }),
		]);
		const { session, ui } = stubProducingSession();

		const result = await runner.dispatchProviderRequest("p0", session, ui);

		expect(result).toBe("p0-1-2");
	});

	it("accumulates agent_start messages and lets the last systemPrompt win; no contribution returns undefined", async () => {
		let secondSawSystemPrompt: string | undefined;
		const runner = new HookRunner([
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

		const quiet = new HookRunner([hook("noop", { before: "agent_start", run() {} })]);
		expect(await quiet.dispatchAgentStart("hi", undefined, "sp0", {}, session, ui)).toBeUndefined();
	});

	it("short-circuits the compact chain on a cancel result", async () => {
		let secondRan = false;
		const runner = new HookRunner([
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
		const runner = new HookRunner([
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
		const errors: HookError[] = [];
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

	it("fails open when a tool_call hook throws: the sink fires and the chain continues", async () => {
		const runner = new HookRunner([
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
		const errors: HookError[] = [];
		runner.onError((error) => errors.push(error));
		const { session, ui } = stubProducingSession();
		const event = toolCallEvent("raw");

		await runner.dispatchToolCall(event, session, ui);

		expect(errors).toEqual([
			{
				path: "<boom>",
				event: "tool_call",
				error: "kaboom",
				stack: expect.stringContaining("kaboom"),
			},
		]);
		// The chain continued past the failure with the event as-is; the second hook still patched it.
		expect(event.input.command).toBe("recovered");
	});

	it("passes the producing session and ui straight through as ctx: deliveries and notifications land", async () => {
		const runner = new HookRunner([
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

		// ctx.session IS the session passed to dispatch: prompt reaches its deliveries directly.
		expect(deliveries).toEqual(["from hook"]);
		// ctx.ui is the UI passed into dispatch: notifications land, carrying the session id.
		expect(notifications).toEqual(["hooked live"]);
	});

	it("reports hook presence via hasHooks", async () => {
		const runner = new HookRunner([hook("guard", { before: "tool_call", run() {} })]);

		expect(runner.hasHooks("tool_call")).toBe(true);
		expect(runner.hasHooks("input")).toBe(false);
	});
});

// ============================================================================
// Hooks folder loader
// ============================================================================

async function writeHooksDir(files: Record<string, string>): Promise<string> {
	const dir = join(await mkdtemp(join(tmpdir(), "wolli-hooks-")), "hooks");
	await mkdir(dir);
	for (const [name, source] of Object.entries(files)) {
		await writeFile(join(dir, name), source);
	}
	return dir;
}

describe("loadHooks", () => {
	it("loads one hook per file: basename name, default-export definition intact", async () => {
		const dir = await writeHooksDir({
			// The real authoring idiom: defineHook imported from the bare "wolli" alias.
			"guard-bash.ts": `
import { defineHook } from "wolli";

export default defineHook({
	before: "tool_call",
	run() {},
});
`,
		});

		const result = await loadHooks([join(dir, "guard-bash.ts")], dir);

		expect(result.errors).toEqual([]);
		expect(result.hooks.map((h) => h.name)).toEqual(["guard-bash"]);
		expect(result.hooks[0].path).toBe(join(dir, "guard-bash.ts"));
		expect(result.hooks[0].definition.before).toBe("tool_call");
		expect(typeof result.hooks[0].definition.run).toBe("function");
	});

	it("collects an error entry per bad file while good files still load", async () => {
		const dir = await writeHooksDir({
			"good.ts": `
export default { before: "input", run() {} };
`,
			// A defineWorkflow result loaded through the "wolli" alias: an object with run but no
			// string before:, so the hook shape check rejects it.
			"is-a-workflow.ts": `
import { defineWorkflow } from "wolli";

export default defineWorkflow({ on: "agent_end", run() {} });
`,
			"no-default.ts": "export const nope = true;\n",
			"explodes.ts": 'throw new Error("kaboom at import");\n',
		});

		const result = await loadHooks(
			[
				join(dir, "good.ts"),
				join(dir, "is-a-workflow.ts"),
				join(dir, "no-default.ts"),
				join(dir, "explodes.ts"),
				join(dir, "missing.ts"),
			],
			dir,
		);

		expect(result.hooks.map((h) => h.name)).toEqual(["good"]);
		expect(result.errors).toEqual([
			{
				path: join(dir, "is-a-workflow.ts"),
				error: expect.stringContaining("does not export a valid defineHook definition"),
			},
			{
				path: join(dir, "no-default.ts"),
				error: expect.stringContaining("does not export a valid defineHook definition"),
			},
			{ path: join(dir, "explodes.ts"), error: expect.stringContaining("Failed to load hook") },
			{ path: join(dir, "missing.ts"), error: expect.stringContaining("Failed to load hook") },
		]);
	});

	it("loads multiple hooks preserving path order: the chain order contract depends on it", async () => {
		const dir = await writeHooksDir({
			"first.ts": `
export default { before: "tool_call", run() {} };
`,
			"second.ts": `
export default { before: "tool_result", run() {} };
`,
			"third.ts": `
export default { before: "input", run() {} };
`,
		});

		const result = await loadHooks([join(dir, "second.ts"), join(dir, "first.ts"), join(dir, "third.ts")], dir);

		expect(result.errors).toEqual([]);
		expect(result.hooks.map((h) => h.name)).toEqual(["second", "first", "third"]);
		expect(result.hooks.map((h) => h.definition.before)).toEqual(["tool_result", "tool_call", "input"]);
	});

	it("rejects an unknown before: event: a silently dead interception hook is a load error", async () => {
		const dir = await writeHooksDir({
			// A stale event name (user_bash is gone) and a typo — both would index under keys
			// nothing dispatches, so the loader refuses them instead of loading dead guards.
			"stale.ts": `
export default { before: "user_bash", run() {} };
`,
			"typo.ts": `
export default { before: "tool_calls", run() {} };
`,
		});

		const result = await loadHooks([join(dir, "stale.ts"), join(dir, "typo.ts")], dir);

		expect(result.hooks).toEqual([]);
		expect(result.errors).toEqual([
			{ path: join(dir, "stale.ts"), error: expect.stringContaining("unknown before: event 'user_bash'") },
			{ path: join(dir, "typo.ts"), error: expect.stringContaining("unknown before: event 'tool_calls'") },
		]);
	});
});

// ============================================================================
// Runtime wiring (the interception seam over a REAL AgentRuntime)
// ============================================================================
//
// The wiring proof, in the extensions/workflows-suite stance: a REAL AgentRuntime in a temp
// agent home with a faux pi-ai provider. Hooks auto-discover from <agentDir>/hooks/, the
// eight interception sites consult HOOKS before EXTENSIONS (order pinned by the input site: an
// extension input handler sees the hook-transformed text), a tool_call hook block short-circuits
// the extension tool_call handler, and hook load errors ride the resource summary.

/** Flatten a message content union (string | content blocks) to its text. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => (block && block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

describe("AgentRuntime hook wiring", () => {
	const AGENT = "hooksmith";
	let home: string;
	let sharedDir: string;
	let markerDir: string;
	const registrations: Array<{ unregister(): void }> = [];

	function makeRuntime(): { runtime: AgentRuntime; registration: ReturnType<typeof registerFauxProvider> } {
		const registration = registerFauxProvider();
		registrations.push(registration);
		// Faux models are typed Model<string>; the runtime wants Model<Api> (Api is a string
		// supertype) — the cast bridges the faux test double to the real shape.
		const model = registration.getModel() as unknown as Model<Api>;
		const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
		const runtime = new AgentRuntime({
			name: AGENT,
			model,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage),
			integrationAccounts: IntegrationAccountStorage.inMemory(),
			integrationStore: IntegrationStore.inMemory(),
		});
		return { runtime, registration };
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "wolli-hook-home-"));
		sharedDir = mkdtempSync(join(tmpdir(), "wolli-hook-shared-"));
		markerDir = mkdtempSync(join(tmpdir(), "wolli-hook-marker-"));
		process.env.WOLLI_HOME = home;
		process.env.WOLLI_SHARED_DIR = sharedDir;
		process.env.WOLLI_TEST_MARKER_DIR = markerDir;
		AgentSettingsManager.createAgent({ name: AGENT });
		mkdirSync(join(getAgentDir(AGENT), "hooks"), { recursive: true });
		mkdirSync(join(getAgentDir(AGENT), "extensions"), { recursive: true });
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

	it("auto-discovers hooks/ and reports the loaded chain via hasHooks", async () => {
		writeFileSync(
			join(getAgentDir(AGENT), "hooks", "watch-input.ts"),
			`
import { defineHook } from "wolli";

export default defineHook({
	before: "input",
	run() {},
});
`,
			"utf-8",
		);
		const { runtime } = makeRuntime();
		await runtime.start();

		expect(runtime.hookRunner).toBeDefined();
		expect(runtime.hookRunner?.hasHooks("input")).toBe(true);
		expect(runtime.hookRunner?.hasHooks("tool_call")).toBe(false);
		await runtime.cleanup();
	});

	it("runs the input hook before the extension handler: the extension sees the hook-transformed text", async () => {
		// Hook transforms the raw text first; the extension records what it saw and transforms again.
		writeFileSync(
			join(getAgentDir(AGENT), "hooks", "tag-input.ts"),
			`
import { defineHook } from "wolli";

export default defineHook({
	before: "input",
	run(evt) {
		return { action: "transform", text: evt.text + "-hook" };
	},
});
`,
			"utf-8",
		);
		writeFileSync(
			join(getAgentDir(AGENT), "extensions", "tag-input-ext.ts"),
			`
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function inputExtension(pi) {
	pi.on("input", (event) => {
		const dir = process.env.WOLLI_TEST_MARKER_DIR;
		if (dir) writeFileSync(join(dir, "ext-input.json"), JSON.stringify({ seen: event.text }));
		return { action: "transform", text: event.text + "-ext" };
	});
}
`,
			"utf-8",
		);
		const { runtime, registration } = makeRuntime();
		await runtime.start();
		let capturedUserText = "";
		registration.setResponses([
			(context) => {
				const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
				capturedUserText = lastUser ? messageText(lastUser.content) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		const session = await runtime.createSession();
		await session.prompt("raw");

		// Order proof: the extension handler ran AFTER the hook, so it saw the hook's "-hook" suffix.
		expect(JSON.parse(readFileSync(join(markerDir, "ext-input.json"), "utf-8"))).toEqual({ seen: "raw-hook" });
		// Both transforms landed on the text the model finally saw.
		expect(capturedUserText).toBe("raw-hook-ext");
		await runtime.cleanup();
	});

	it("lets a tool_call hook block short-circuit the extension tool_call handler", async () => {
		writeFileSync(
			join(getAgentDir(AGENT), "hooks", "guard-tool.ts"),
			`
import { defineHook } from "wolli";

export default defineHook({
	before: "tool_call",
	run() {
		return { block: true, reason: "blocked by hook" };
	},
});
`,
			"utf-8",
		);
		writeFileSync(
			join(getAgentDir(AGENT), "extensions", "watch-tool-ext.ts"),
			`
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function toolCallExtension(pi) {
	pi.on("tool_call", () => {
		const dir = process.env.WOLLI_TEST_MARKER_DIR;
		if (dir) writeFileSync(join(dir, "ext-toolcall.json"), JSON.stringify({ ran: true }));
		return undefined;
	});
}
`,
			"utf-8",
		);
		const { runtime, registration } = makeRuntime();
		await runtime.start();
		// First turn: the model calls bash; the hook blocks it (the tool never runs). The blocked
		// tool result feeds back and the second response ends the turn.
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		const session = await runtime.createSession();
		await session.harness.prompt("go");

		// The hook blocked before the extension chain, so the extension tool_call handler never ran.
		expect(existsSync(join(markerDir, "ext-toolcall.json"))).toBe(false);
		await runtime.cleanup();
	});

	it("surfaces hook load errors in the resource summary", async () => {
		writeFileSync(join(getAgentDir(AGENT), "hooks", "no-default.ts"), "export const nope = true;\n", "utf-8");
		const { runtime } = makeRuntime();
		await runtime.start();

		const summary = runtime.getResourceSummary();
		expect(
			summary.diagnostics.some(
				(d) => d.type === "error" && d.path?.endsWith("no-default.ts") && d.message.includes("defineHook"),
			),
		).toBe(true);
		await runtime.cleanup();
	});
});

// ============================================================================
// Doc conformance (docs/hooks.md)
// ============================================================================
//
// Each substantive code example in docs/hooks.md, loaded verbatim through the real loader and
// exercised against the real HookRunner. Keep the fixtures and the doc in lockstep: if a test
// forces a fixture change, change the doc block too.

describe("doc examples (docs/hooks.md)", () => {
	const docFixtures: Record<string, string> = {
		"guard-bash.ts": `
import { defineHook, isToolCallEventType } from "wolli";

export default defineHook({
  before: "tool_call",
  run(event) {
    if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
      return { block: true, reason: "destructive command blocked" };
    }
  },
});
`,
		"redact-input.ts": `
import { defineHook } from "wolli";

export default defineHook({
  before: "input",
  run(event) {
    const redacted = event.text.replace(/sk-[a-z0-9]+/gi, "[redacted]");
    if (redacted === event.text) return;
    return { action: "transform", text: redacted };
  },
});
`,
		"confirm-compact.ts": `
import { defineHook } from "wolli";

export default defineHook({
  before: "compact",
  async run(event, ctx) {
    const ok = await ctx.ui.confirm("Compact now?", "Older messages will be summarized.");
    if (!ok) return { cancel: true };
  },
});
`,
	};

	async function loadDocHook(name: string): Promise<HookRunner> {
		const dir = await writeHooksDir({ [name]: docFixtures[name] });
		const result = await loadHooks([join(dir, name)], dir);
		expect(result.errors).toEqual([]);
		return new HookRunner(result.hooks);
	}

	it("guard-bash blocks a destructive bash call and passes everything else", async () => {
		const runner = await loadDocHook("guard-bash.ts");
		const { session, ui } = stubProducingSession();

		const blocked = await runner.dispatchToolCall(
			{ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "rm -rf /" } },
			session,
			ui,
		);
		expect(blocked).toEqual({ block: true, reason: "destructive command blocked" });

		const passed = await runner.dispatchToolCall(
			{ type: "tool_call", toolCallId: "t2", toolName: "bash", input: { command: "ls" } },
			session,
			ui,
		);
		expect(passed).toBeUndefined();
	});

	it("redact-input rewrites a secret in the input text and leaves clean text alone", async () => {
		const runner = await loadDocHook("redact-input.ts");
		const { session, ui } = stubProducingSession();

		expect(await runner.dispatchInput("token sk-abc123", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "transform",
			text: "token [redacted]",
			images: undefined,
		});
		expect(await runner.dispatchInput("hello", undefined, "interactive", undefined, session, ui)).toEqual({
			action: "continue",
		});
	});

	it("confirm-compact cancels when the user declines and proceeds when they accept", async () => {
		const runner = await loadDocHook("confirm-compact.ts");
		const base = stubProducingSession();

		const declineUi: DialogUI = { ...base.ui, confirm: async () => false };
		expect(await runner.dispatchCompact(compactEvent(), base.session, declineUi)).toEqual({ cancel: true });

		const acceptUi: DialogUI = { ...base.ui, confirm: async () => true };
		expect(await runner.dispatchCompact(compactEvent(), base.session, acceptUi)).toBeUndefined();
	});
});
