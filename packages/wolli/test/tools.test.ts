/**
 * Tools capability: the defineTool authoring surface, the tools/ loader, the authored-tool
 * wrapper, and the full-runtime wiring.
 *
 * `defineTool` is identity at runtime, so the unit value is that identity plus compile-time
 * assertions that the parameters schema narrows `execute`'s params and that ctx is the tool
 * context — `pnpm typecheck` includes test files, so the `expectTypeOf` lines are gated.
 *
 * The wiring suite mirrors extensions.test.ts: a REAL AgentRuntime against a temp agent
 * home + a faux pi-ai provider, proving tools/ loads with NO extensions dir present
 * (workflow- and extension-independence), executes with the calling session's facade and
 * the integration resolver, dedupes name collisions with diagnostics, and reloads.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@opsyhq/agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { Session } from "../src/core/extensions/types.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	defineIntegration,
	IntegrationRunner,
	loadIntegrationFromDefinition,
	loadIntegrations,
} from "../src/core/integrations/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { loadTools } from "../src/core/tools/loader.ts";
import { wrapAuthoredTool } from "../src/core/tools/tool-definition-wrapper.ts";
import { defineTool, type ToolContext, type ToolDefinition } from "../src/core/tools/types.ts";
import type { IntegrationHandleOf, IntegrationKey } from "../src/core/workflows/types.ts";
import { defineTool as barrelDefineTool } from "../src/index.ts";

// ============================================================================
// defineTool (the authoring surface)
// ============================================================================

describe("defineTool", () => {
	it("is identity at runtime", () => {
		const definition: ToolDefinition = {
			name: "noop",
			label: "Noop",
			description: "Does nothing.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: undefined };
			},
		};
		expect(defineTool(definition)).toBe(definition);
	});

	it("preserves parameter inference and types ctx as the tool context", () => {
		const tool = defineTool({
			name: "http_get",
			label: "HTTP GET",
			description: "Fetch a URL over HTTP GET.",
			parameters: Type.Object({ url: Type.String() }),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				expectTypeOf(toolCallId).toEqualTypeOf<string>();
				expectTypeOf(params.url).toEqualTypeOf<string>();
				expectTypeOf(ctx).toEqualTypeOf<ToolContext>();
				expectTypeOf(ctx.session).toEqualTypeOf<Session>();
				return { content: [{ type: "text", text: params.url }], details: { url: params.url } };
			},
		});
		expect(tool.name).toBe("http_get");
	});

	it("is the defineTool the package barrel exports", () => {
		expect(barrelDefineTool).toBe(defineTool);
	});
});

// ============================================================================
// loadTools (the tools/ folder loader)
// ============================================================================

const HTTP_GET_TOOL_SOURCE = `
import { defineTool } from "wolli";
import { Type } from "typebox";

export default defineTool({
	name: "http_get",
	label: "HTTP GET",
	description: "Fetch a URL over HTTP GET.",
	parameters: Type.Object({ url: Type.String() }),
	async execute(_toolCallId, { url }) {
		return { content: [{ type: "text", text: url }] };
	},
});
`;

describe("loadTools", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wolli-tools-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads a defineTool file importing the bare wolli specifier", async () => {
		const toolPath = join(dir, "http_get.ts");
		writeFileSync(toolPath, HTTP_GET_TOOL_SOURCE, "utf-8");

		const result = await loadTools([toolPath], dir);

		expect(result.errors).toEqual([]);
		expect(result.tools).toHaveLength(1);
		expect(result.tools[0].definition.name).toBe("http_get");
		expect(result.tools[0].path).toBe(toolPath);
	});

	it("records a non-definition default export as an error entry, not a throw", async () => {
		const badPath = join(dir, "bad.ts");
		writeFileSync(badPath, "export default 42;\n", "utf-8");

		const result = await loadTools([badPath], dir);

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(badPath);
		expect(result.errors[0].error).toContain("defineTool");
	});
});

// ============================================================================
// wrapAuthoredTool (the AgentTool bridge)
// ============================================================================

describe("wrapAuthoredTool", () => {
	it("copies the definition surface and threads ctx, result, and onUpdate", async () => {
		const seen: { toolCallId?: string; text?: string; ctx?: ToolContext } = {};
		const definition = defineTool({
			name: "echo",
			label: "Echo",
			description: "Echoes text.",
			parameters: Type.Object({ text: Type.String() }),
			executionMode: "sequential",
			async execute(toolCallId, { text }, _signal, onUpdate, ctx) {
				seen.toolCallId = toolCallId;
				seen.text = text;
				seen.ctx = ctx;
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: "partial" });
				return { content: [{ type: "text", text }], details: "final" };
			},
		});
		const session = {} as Session;
		const ctx: ToolContext = {
			session,
			integration: () => {
				throw new Error("unused in this test");
			},
		};

		const wrapped = wrapAuthoredTool(definition, () => ctx);

		expect(wrapped.name).toBe("echo");
		expect(wrapped.label).toBe("Echo");
		expect(wrapped.executionMode).toBe("sequential");

		const updates: AgentToolResult<unknown>[] = [];
		const result = await wrapped.execute("call-1", { text: "hi" }, undefined, (partial) => updates.push(partial));

		expect(seen.toolCallId).toBe("call-1");
		expect(seen.text).toBe("hi");
		expect(seen.ctx?.session).toBe(session);
		expect(updates).toEqual([{ content: [{ type: "text", text: "partial" }], details: "partial" }]);
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(result.details).toBe("final");
	});

	it("resolves ctx.integration action calls against a live IntegrationRunner", async () => {
		const heartbeat = defineIntegration({
			account: Type.Object({}),
			actions: {
				ping: {
					parameters: Type.Object({}),
					execute: async () => ({ ok: true }),
				},
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

		const definition = defineTool({
			name: "ping_heartbeat",
			label: "Ping Heartbeat",
			description: "Pings the heartbeat integration.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const pong = await ctx.integration(heartbeat).ping({});
				return { content: [{ type: "text", text: JSON.stringify(pong) }], details: pong };
			},
		});

		// The flat handle over the runner surface — the same shape the runtime's ctx builder produces.
		const ctx: ToolContext = {
			session: {} as Session,
			integration: <TActions>(key: IntegrationKey<TActions>) => {
				const handle = runner.getIntegration(key.service);
				const capability = runner.getServiceCapabilities().find((c) => c.service === key.service);
				const actions: Record<string, (params: unknown) => Promise<unknown>> = {};
				for (const action of capability?.actions ?? []) {
					actions[action] = (params) => handle.call(action, params);
				}
				return actions as IntegrationHandleOf<TActions>;
			},
		};

		const wrapped = wrapAuthoredTool(definition, () => ctx);
		const result = await wrapped.execute("call-1", {}, undefined, undefined);

		expect(result.details).toEqual({ ok: true });
	});
});

// ============================================================================
// Full-runtime wiring (mirror of extensions.test.ts)
// ============================================================================

const AGENT = "toolsmith";

// Records the calling session's id off ctx.session — the facade-threading proof.
const ECHO_TOOL_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "wolli";

export default defineTool({
	name: "echo",
	label: "Echo",
	description: "Echoes the provided text back.",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_toolCallId, { text }, _signal, _onUpdate, ctx) {
		const dir = process.env.WOLLI_TEST_MARKER_DIR;
		if (dir) {
			writeFileSync(
				join(dir, "echo.json"),
				JSON.stringify({ sessionId: ctx.session.sessionManager.getSessionId(), text }),
			);
		}
		return { content: [{ type: "text", text }] };
	},
});
`;

// Registers an extension tool named "echo" — the collision loser once tools/echo.ts exists.
const ECHO_EXTENSION_SOURCE = `
import { Type } from "typebox";

export default function echoExtension(pi) {
	pi.registerTool({
		name: "echo",
		label: "Extension Echo",
		description: "Extension-registered echo.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: String(params.text) }] };
		},
	});
}
`;

// Collides with the built-in read tool — must be dropped with an error diagnostic.
const READ_SHADOW_TOOL_SOURCE = `
import { Type } from "typebox";
import { defineTool } from "wolli";

export default defineTool({
	name: "read",
	label: "Shadow Read",
	description: "Tries to shadow the built-in read tool.",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "shadowed" }] };
	},
});
`;

const HEARTBEAT_INTEGRATION_SOURCE = `
import { Type } from "typebox";
import { defineIntegration } from "wolli";

export default defineIntegration({
	account: Type.Object({}),
	actions: {
		ping: {
			parameters: Type.Object({}),
			execute: async () => ({ ok: true }),
		},
	},
});
`;

// Imports its integration's definition as the typed ctx.integration key — the cron-tool shape.
const PINGER_TOOL_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "wolli";
import heartbeat from "../integrations/heartbeat.ts";

export default defineTool({
	name: "ping_heartbeat",
	label: "Ping Heartbeat",
	description: "Pings the heartbeat integration.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const pong = await ctx.integration(heartbeat).ping({});
		const dir = process.env.WOLLI_TEST_MARKER_DIR;
		if (dir) writeFileSync(join(dir, "pong.json"), JSON.stringify(pong));
		return { content: [{ type: "text", text: JSON.stringify(pong) }] };
	},
});
`;

const LATE_TOOL_SOURCE = `
import { Type } from "typebox";
import { defineTool } from "wolli";

export default defineTool({
	name: "late",
	label: "Late",
	description: "Added after startup; picked up by /reload.",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "late" }] };
	},
});
`;

describe("tools subsystem wiring", () => {
	let home: string;
	let sharedDir: string;
	let markerDir: string;
	const registrations: Array<{ unregister(): void }> = [];

	function makeRuntime(accounts = IntegrationAccountStorage.inMemory()): {
		runtime: AgentRuntime;
		registration: ReturnType<typeof registerFauxProvider>;
	} {
		const registration = registerFauxProvider();
		registrations.push(registration);
		// Faux models are typed Model<string>; the runtime wants Model<Api> (Api is a
		// string supertype) — the cast bridges the faux test double to the real shape.
		const model = registration.getModel() as unknown as Model<Api>;
		const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
		const runtime = new AgentRuntime({
			name: AGENT,
			model,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage),
			integrationAccounts: accounts,
			integrationStore: IntegrationStore.inMemory(),
		});
		return { runtime, registration };
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "wolli-tools-home-"));
		sharedDir = mkdtempSync(join(tmpdir(), "wolli-tools-shared-"));
		markerDir = mkdtempSync(join(tmpdir(), "wolli-tools-marker-"));
		process.env.WOLLI_HOME = home;
		process.env.WOLLI_SHARED_DIR = sharedDir;
		process.env.WOLLI_TEST_MARKER_DIR = markerDir;

		AgentSettingsManager.createAgent({ name: AGENT });

		// Tools ONLY — no extensions dir, proving tools/ loads independent of the extension system.
		const toolsDir = join(getAgentDir(AGENT), "tools");
		mkdirSync(toolsDir, { recursive: true });
		writeFileSync(join(toolsDir, "echo.ts"), ECHO_TOOL_SOURCE, "utf-8");
	});

	afterEach(async () => {
		for (const registration of registrations.splice(0)) registration.unregister();
		delete process.env.WOLLI_HOME;
		delete process.env.WOLLI_SHARED_DIR;
		delete process.env.WOLLI_TEST_MARKER_DIR;
		rmSync(home, { recursive: true, force: true });
		rmSync(sharedDir, { recursive: true, force: true });
		rmSync(markerDir, { recursive: true, force: true });
	});

	it("loads one definition and one error entry through the resource loader's tools arm", async () => {
		const agentDir = getAgentDir(AGENT);
		writeFileSync(join(agentDir, "tools", "broken.ts"), "export default 42;\n", "utf-8");

		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: AgentSettingsManager.create(AGENT),
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const { tools, errors } = loader.getTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].definition.name).toBe("echo");
		expect(errors).toHaveLength(1);
		expect(errors[0].path.endsWith("broken.ts")).toBe(true);
	});

	it("merges tools/ into session tooling with no extensions dir present", async () => {
		expect(existsSync(join(getAgentDir(AGENT), "extensions"))).toBe(false);
		const { runtime } = makeRuntime();
		await runtime.start();
		const session = await runtime.createSession();

		expect(session.harness.getTools().map((tool) => tool.name)).toContain("echo");
		expect(runtime.getResourceSummary().tools).toBe(1);
		await runtime.cleanup();
	});

	it("executes an authored tool with the calling session's facade as ctx.session", async () => {
		const { runtime, registration } = makeRuntime();
		await runtime.start();
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		const session = await runtime.createSession();
		await session.harness.prompt("go");

		const marker = JSON.parse(readFileSync(join(markerDir, "echo.json"), "utf-8"));
		expect(marker).toEqual({ sessionId: session.getSessionId(), text: "hi" });
		await runtime.cleanup();
	});

	it("resolves ctx.integration to the stamped integration and calls its action", async () => {
		const agentDir = getAgentDir(AGENT);
		mkdirSync(join(agentDir, "integrations"), { recursive: true });
		writeFileSync(join(agentDir, "integrations", "heartbeat.ts"), HEARTBEAT_INTEGRATION_SOURCE, "utf-8");
		writeFileSync(join(agentDir, "tools", "pinger.ts"), PINGER_TOOL_SOURCE, "utf-8");

		const { runtime, registration } = makeRuntime(IntegrationAccountStorage.inMemory({ heartbeat: {} }));
		await runtime.start();
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("ping_heartbeat", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		const session = await runtime.createSession();
		await session.harness.prompt("go");

		expect(JSON.parse(readFileSync(join(markerDir, "pong.json"), "utf-8"))).toEqual({ ok: true });
		await runtime.cleanup();
	});

	it("dedupes name collisions: base tools beat authored, authored beat extension-registered", async () => {
		const agentDir = getAgentDir(AGENT);
		writeFileSync(join(agentDir, "tools", "read.ts"), READ_SHADOW_TOOL_SOURCE, "utf-8");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "echo-ext.ts"), ECHO_EXTENSION_SOURCE, "utf-8");

		const { runtime } = makeRuntime();
		await runtime.start();
		const session = await runtime.createSession();

		const toolNames = session.harness.getTools().map((tool) => tool.name);
		expect(toolNames.filter((name) => name === "echo")).toHaveLength(1);
		expect(toolNames.filter((name) => name === "read")).toHaveLength(1);

		const diagnostics = runtime.getResourceSummary().diagnostics;
		expect(
			diagnostics.some((d) => d.type === "error" && d.message.includes('"read"') && d.path?.endsWith("read.ts")),
		).toBe(true);
		expect(diagnostics.some((d) => d.type === "warning" && d.message.includes('"echo"'))).toBe(true);
		await runtime.cleanup();
	});

	it("reload picks up a new tools file", async () => {
		const { runtime } = makeRuntime();
		await runtime.start();
		const session = await runtime.createSession();
		expect(session.harness.getTools().map((tool) => tool.name)).not.toContain("late");

		writeFileSync(join(getAgentDir(AGENT), "tools", "late.ts"), LATE_TOOL_SOURCE, "utf-8");
		await runtime.reload();

		expect(session.harness.getTools().map((tool) => tool.name)).toContain("late");
		expect(runtime.getResourceSummary().tools).toBe(2);
		await runtime.cleanup();
	});
});

// ============================================================================
// Built-in cron tool (the scheduler plugin's defineTool half)
// ============================================================================

const SYNTHETIC_SCHEDULER_SOURCE = `
import { defineIntegration } from "wolli";
import { Type } from "typebox";

// Stands in for the croner-backed built-in index.ts (its deps are not installed in-repo).
// addJob persists its params so the test can read back what cron snapshotted.
export default defineIntegration({
	account: Type.Object({}),
	events: {
		due: Type.Object({
			id: Type.String(),
			prompt: Type.String(),
			originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
			name: Type.Optional(Type.String()),
		}),
	},
	actions: {
		addJob: {
			parameters: Type.Object({
				prompt: Type.String(),
				name: Type.Optional(Type.String()),
				schedule: Type.Unknown(),
				originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
			}),
			execute: async (params, ctx) => {
				ctx.store.set("lastAdd", params);
				return { id: "job-1", nextRunAt: 0 };
			},
		},
	},
});
`;

describe("built-in cron tool", () => {
	it("add snapshots the calling session's tags into addJob's originTags", async () => {
		// The dir basename becomes the stamped service, and cron.ts imports "./index.ts", so a
		// copy of the real cron.ts lives beside a synthetic scheduler. Both loaders share the
		// module cache, so cron's import resolves to the stamped synthetic — the same seam
		// integrations.test.ts proves for the workflow half.
		const root = mkdtempSync(join(tmpdir(), "wolli-cron-"));
		const dir = join(root, "scheduler");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.ts"), SYNTHETIC_SCHEDULER_SOURCE, "utf-8");
		copyFileSync(
			join(import.meta.dirname, "..", "built-in", "plugins", "scheduler", "cron.ts"),
			join(dir, "cron.ts"),
		);

		const integrationsResult = await loadIntegrations([join(dir, "index.ts")], dir);
		expect(integrationsResult.errors).toEqual([]);
		const service = integrationsResult.integrations[0].service;
		expect(service).toBe("scheduler");

		const store = IntegrationStore.inMemory();
		const runner = new IntegrationRunner(
			integrationsResult.integrations,
			dir,
			IntegrationAccountStorage.inMemory({ [service]: {} }),
			store,
		);
		runner.bindCore();

		const toolsResult = await loadTools([join(dir, "cron.ts")], dir);
		expect(toolsResult.errors).toEqual([]);
		const cron = toolsResult.tools[0].definition;

		const tags = { "telegram:chat": "7" };
		const ctx: ToolContext = {
			session: { getTags: () => tags } as unknown as Session,
			integration: <TActions>(key: IntegrationKey<TActions>) => {
				const handle = runner.getIntegration(key.service);
				const capability = runner.getServiceCapabilities().find((c) => c.service === key.service);
				const actions: Record<string, (params: unknown) => Promise<unknown>> = {};
				for (const action of capability?.actions ?? []) {
					actions[action] = (params) => handle.call(action, params);
				}
				return actions as IntegrationHandleOf<TActions>;
			},
		};

		const wrapped = wrapAuthoredTool(cron, () => ctx);
		const result = await wrapped.execute(
			"call-1",
			{ action: "add", prompt: "digest", everyMs: 60000 },
			undefined,
			undefined,
		);

		// The reply confirms the add ran; the store confirms the session tags were snapshotted.
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(store.get(service, "lastAdd")).toMatchObject({
			prompt: "digest",
			schedule: { kind: "every", everyMs: 60000 },
			originTags: { "telegram:chat": "7" },
		});

		rmSync(root, { recursive: true, force: true });
	});
});
