/**
 * Extension-subsystem integration: the four functional checks the Tier 5 wiring
 * (AgentRuntime) exists to deliver. Each builds a REAL AgentRuntime against a
 * temp agent home + a faux pi-ai provider (no network), so the whole seam runs:
 * discovery → load → runner → frozen prompt → tool registration → core binding →
 * event translation.
 *
 *  1. discovered skills are frozen into the system prompt the harness sends;
 *  2. an extension's registerTool reaches the harness AND its session_start
 *     lifecycle handler fires on create;
 *  3. an extension's message_end mutation is applied in place and persisted;
 *  4. createConversation() invalidates the superseded runner (a captured steward goes stale).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { convertToLlm, createBashExecutionMessage } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { openAgentSession } from "../src/core/session.ts";

const AGENT = "scribe";

// A self-contained extension: registers a tool, records its session_start, and
// rewrites every finalized assistant message to a sentinel via message_end. It is
// loaded by jiti at runtime (never typechecked by the suite), so it reads its
// marker dir from the env each call rather than relying on the suite's types.
const EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export default function testExtension(pi) {
	pi.registerTool({
		name: "test_echo",
		label: "Test Echo",
		description: "Echoes the provided text back.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: String(params.text) }] };
		},
	});

	pi.on("session_start", (event) => {
		const dir = process.env.STEWARD_TEST_MARKER_DIR;
		if (dir) writeFileSync(join(dir, "session_start.json"), JSON.stringify({ reason: event.reason }));
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return undefined;
		return { message: { ...event.message, content: [{ type: "text", text: "MUTATED_BY_EXTENSION" }] } };
	});
}
`;

const SKILL_SOURCE = `---
name: note-taking
description: Guidance for taking structured, durable meeting notes.
---

# Note Taking

Take clear, structured notes.
`;

// Registers a `/greet` command that records its raw argument string to the marker dir.
const COMMAND_EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function commandExtension(pi) {
	pi.registerCommand("greet", {
		description: "Greets the provided name.",
		async handler(args) {
			const dir = process.env.STEWARD_TEST_MARKER_DIR;
			if (dir) writeFileSync(join(dir, "command.json"), JSON.stringify({ args }));
		},
	});
}
`;

// Registers a `/cap` command whose handler closes over the agent-global `steward`; calling a steward
// method after the runner is superseded throws stale (the captured-handle guard).
const STALE_CAPTURE_EXTENSION_SOURCE = `
export default function staleExtension(pi) {
	pi.registerCommand("cap", {
		description: "Calls a steward method; throws once the runner is superseded.",
		async handler() {
			await pi.listSessions();
		},
	});
}
`;

// Registers a `/facade` command that drives the agent via the agent-global steward API: records the
// live conversation's session id and the stored-session count to the marker dir.
const AGENT_FACADE_EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function facadeExtension(pi) {
	pi.registerCommand("facade", {
		description: "Records the live conversation id + session count via steward.getConversation()/listSessions().",
		async handler() {
			const dir = process.env.STEWARD_TEST_MARKER_DIR;
			const convo = pi.getConversation();
			const sessions = await pi.listSessions();
			if (dir) {
				writeFileSync(
					join(dir, "facade.json"),
					JSON.stringify({ sessionId: convo ? convo.sessionManager.getSessionId() : null, sessionCount: sessions.length }),
				);
			}
		},
	});
}
`;

// Transforms the literal input "raw" into "transformed"; short-circuits "skipme".
const INPUT_EXTENSION_SOURCE = `
export default function inputExtension(pi) {
	pi.on("input", (event) => {
		if (event.text === "raw") return { action: "transform", text: "transformed" };
		if (event.text === "skipme") return { action: "handled" };
		return { action: "continue" };
	});
}
`;

// Handles user_bash itself, returning a synthetic result keyed off the command.
const USER_BASH_EXTENSION_SOURCE = `
export default function bashExtension(pi) {
	pi.on("user_bash", (event) => ({
		result: { output: "intercepted:" + event.command, exitCode: 0, cancelled: false, truncated: false },
	}));
}
`;

// Throws while loading, so the loader records it as an extension load error.
const BROKEN_EXTENSION_SOURCE = `
export default function brokenExtension() {
	throw new Error("boom");
}
`;

let home: string;
let sharedDir: string;
let markerDir: string;
const registrations: Array<{ unregister(): void }> = [];

function makeRuntime(): { runtime: AgentRuntime; registration: ReturnType<typeof registerFauxProvider> } {
	const registration = registerFauxProvider();
	registrations.push(registration);
	// Faux models are typed Model<string>; the runtime wants Model<Api> (Api is a
	// string supertype) — the cast bridges the faux test double to the real shape.
	const model = registration.getModel() as unknown as Model<Api>;
	const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
	// Request-time auth routes through ModelRegistry, which requires a resolvable API
	// key; the faux provider has none, so inject a runtime override (stands in for a
	// real provider being authed).
	authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
	const runtime = new AgentRuntime({
		name: AGENT,
		model,
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage),
		integrationAccounts: IntegrationAccountStorage.inMemory(),
	});
	return { runtime, registration };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-ext-home-"));
	sharedDir = mkdtempSync(join(tmpdir(), "steward-ext-shared-"));
	markerDir = mkdtempSync(join(tmpdir(), "steward-ext-marker-"));
	process.env.STEWARD_HOME = home;
	process.env.STEWARD_SHARED_DIR = sharedDir;
	process.env.STEWARD_TEST_MARKER_DIR = markerDir;

	AgentSettingsManager.createAgent({ name: AGENT });

	const agentDir = getAgentDir(AGENT);
	// Skill: <agentDir>/skills/note-taking/SKILL.md → loaded as a "user" skill.
	const skillDir = join(agentDir, "skills", "note-taking");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), SKILL_SOURCE, "utf-8");
	// Extension: <agentDir>/extensions/test-ext.ts → discovered as a global extension.
	const extDir = join(agentDir, "extensions");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(join(extDir, "test-ext.ts"), EXTENSION_SOURCE, "utf-8");
});

afterEach(async () => {
	for (const registration of registrations.splice(0)) registration.unregister();
	delete process.env.STEWARD_HOME;
	delete process.env.STEWARD_SHARED_DIR;
	delete process.env.STEWARD_TEST_MARKER_DIR;
	rmSync(home, { recursive: true, force: true });
	rmSync(sharedDir, { recursive: true, force: true });
	rmSync(markerDir, { recursive: true, force: true });
});

describe("extension subsystem wiring", () => {
	it("freezes discovered skills into the system prompt the harness sends", async () => {
		const { runtime, registration } = makeRuntime();
		let capturedSystemPrompt = "";
		registration.setResponses([
			(context) => {
				capturedSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);

		const conversation = await runtime.createConversation();
		await conversation.harness.prompt("hello");

		expect(capturedSystemPrompt).toContain("<available_skills>");
		expect(capturedSystemPrompt).toContain("note-taking");
		await runtime.cleanup();
	});

	it("registers extension tools on the harness and fires session_start on create", async () => {
		const { runtime } = makeRuntime();

		const conversation = await runtime.createConversation();

		// registerTool reached the harness alongside the built-ins.
		expect(conversation.harness.getTools().map((tool) => tool.name)).toContain("test_echo");

		// session_start fired with reason "new" (fresh build) — recorded by the extension.
		const marker = JSON.parse(readFileSync(join(markerDir, "session_start.json"), "utf-8"));
		expect(marker).toEqual({ reason: "new" });
		await runtime.cleanup();
	});

	it("applies and persists a message_end mutation", async () => {
		const { runtime, registration } = makeRuntime();
		registration.setResponses([() => fauxAssistantMessage("original assistant text")]);

		const conversation = await runtime.createConversation();
		await conversation.harness.prompt("hello");
		await runtime.cleanup();

		// Re-open the session from disk: the persisted assistant message must carry the
		// extension's in-place replacement, proving the mutation survived to durable state.
		const { session } = await openAgentSession(AGENT, { fresh: false });
		const entries = await session.getEntries();
		const assistant = entries.find((e) => e.type === "message" && e.message.role === "assistant");
		if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant") {
			throw new Error("no persisted assistant message");
		}
		const content = assistant.message.content;
		const text =
			typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toBe("MUTATED_BY_EXTENSION");
	});

	it("invalidates a captured steward on createConversation", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "cap-ext.ts"), STALE_CAPTURE_EXTENSION_SOURCE, "utf-8");
		const { runtime } = makeRuntime();
		await runtime.createConversation();

		const previousRunner = runtime.extensionRunner;
		const captured = previousRunner.getCommand("cap");
		expect(captured).toBeDefined();
		const runCaptured = () => captured?.handler("", previousRunner.createContext());

		// The captured steward works before the swap.
		await expect(runCaptured()).resolves.toBeUndefined();

		// Creating another conversation swaps the runner in place and invalidates the previous one.
		await runtime.createConversation();

		// Any steward captured from the superseded runner now throws stale.
		await expect(runCaptured()).rejects.toThrow(/stale/);
		// The runtime now exposes a fresh, live runner.
		expect(runtime.extensionRunner).not.toBe(previousRunner);
		await runtime.cleanup();
	});

	it("runs an extension command and does not reach the model", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "cmd-ext.ts"), COMMAND_EXTENSION_SOURCE, "utf-8");
		const { runtime, registration } = makeRuntime();
		const conversation = await runtime.createConversation();

		await conversation.prompt("/greet there");

		const marker = JSON.parse(readFileSync(join(markerDir, "command.json"), "utf-8"));
		expect(marker).toEqual({ args: "there" });
		// The command handled the input itself — no model turn ran.
		expect(registration.state.callCount).toBe(0);
		await runtime.cleanup();
	});

	it("exposes steward.getConversation()/listSessions() so a command resolves the live conversation and lists sessions", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "facade-ext.ts"), AGENT_FACADE_EXTENSION_SOURCE, "utf-8");
		const { runtime } = makeRuntime();
		const conversation = await runtime.createConversation();

		await conversation.prompt("/facade");

		const marker = JSON.parse(readFileSync(join(markerDir, "facade.json"), "utf-8"));
		// steward.getConversation() resolved the SAME live conversation the runtime built.
		expect(marker.sessionId).toBe(conversation.getSessionId());
		// steward.listSessions() surfaced the stored session create() wrote eagerly.
		expect(marker.sessionCount).toBeGreaterThanOrEqual(1);
		await runtime.cleanup();
	});

	it("resumes a stored session by id and lists stored sessions", async () => {
		const { runtime, registration } = makeRuntime();
		registration.setResponses([() => fauxAssistantMessage("a"), () => fauxAssistantMessage("b")]);

		// Session A gets some history, then capture its id.
		const a = await runtime.createConversation();
		await a.harness.prompt("hello from A");
		const idA = a.getSessionId();

		// Session B becomes the live conversation.
		const b = await runtime.createConversation();
		await b.harness.prompt("hello from B");
		expect(b.getSessionId()).not.toBe(idA);

		// Both stored sessions are listable.
		const ids = (await runtime.listSessions()).map((session) => session.id);
		expect(ids).toContain(idA);
		expect(ids).toContain(b.getSessionId());

		// Resume A by id → it becomes the live conversation again, carrying its persisted history.
		const resumed = await runtime.resumeConversation(idA);
		expect(resumed.getSessionId()).toBe(idA);
		expect(runtime.getConversation()?.getSessionId()).toBe(idA);
		expect(resumed.getEntries().some((entry) => entry.type === "message")).toBe(true);
		await runtime.cleanup();
	});

	it("throws resuming an unknown session id", async () => {
		const { runtime } = makeRuntime();
		await runtime.createConversation();
		await expect(runtime.resumeConversation("does-not-exist")).rejects.toThrow(/No session/);
		await runtime.cleanup();
	});

	it("applies an input transform and short-circuits a handled input", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "input-ext.ts"), INPUT_EXTENSION_SOURCE, "utf-8");
		const { runtime, registration } = makeRuntime();
		let capturedUserText = "";
		registration.setResponses([
			(context) => {
				const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
				capturedUserText = lastUser ? messageText(lastUser.content) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		const conversation = await runtime.createConversation();

		// "raw" is rewritten before reaching the model.
		await conversation.prompt("raw");
		expect(capturedUserText).toBe("transformed");

		// "skipme" is fully handled by the extension — no further model turn.
		const callsBefore = registration.state.callCount;
		await conversation.prompt("skipme");
		expect(registration.state.callCount).toBe(callsBefore);
		await runtime.cleanup();
	});

	it("lets an extension handle user_bash and returns its result", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "bash-ext.ts"), USER_BASH_EXTENSION_SOURCE, "utf-8");
		const { runtime } = makeRuntime();
		await runtime.createConversation();

		const result = await runtime.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "echo hi",
			excludeFromContext: false,
			cwd: runtime.getCwd(),
		});

		expect(result?.result?.output).toBe("intercepted:echo hi");
		await runtime.cleanup();
	});

	it("records ! bash output into context and excludes !!", () => {
		const bashResult = { output: "a.txt\nb.txt\n", exitCode: 0, cancelled: false, truncated: false };
		const included = createBashExecutionMessage("ls", bashResult, { excludeFromContext: false });
		const excluded = createBashExecutionMessage("ls", bashResult, { excludeFromContext: true });

		// `!` enters the model context as a user message carrying the command + output.
		const convertedIncluded = convertToLlm([included]);
		expect(convertedIncluded).toHaveLength(1);
		expect(convertedIncluded[0].role).toBe("user");
		expect(messageText(convertedIncluded[0].content)).toContain("ls");
		expect(messageText(convertedIncluded[0].content)).toContain("a.txt");

		// `!!` is recorded for display but withheld from the model context.
		expect(convertToLlm([excluded])).toHaveLength(0);
	});

	it("reload picks up new resources and preserves the transcript", async () => {
		const { runtime, registration } = makeRuntime();
		registration.setResponses([() => fauxAssistantMessage("hi there")]);
		const conversation = await runtime.createConversation();
		await conversation.prompt("hello");

		const messagesBefore = conversation.getEntries().filter((e) => e.type === "message").length;
		expect(messagesBefore).toBeGreaterThan(0);

		const agentDir = getAgentDir(AGENT);
		const skillDir = join(agentDir, "skills", "research");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: research\ndescription: Research helper.\n---\n\n# Research\n",
			"utf-8",
		);
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(
			join(agentDir, "prompts", "summarize.md"),
			"---\ndescription: Summarize.\n---\nSummarize: $ARGUMENTS\n",
			"utf-8",
		);
		writeFileSync(join(agentDir, "extensions", "cmd-ext.ts"), COMMAND_EXTENSION_SOURCE, "utf-8");

		await runtime.reload();

		const commandNames = runtime.getCommands().map((c) => c.name);
		expect(commandNames).toContain("skill:research");
		expect(commandNames).toContain("summarize");
		expect(commandNames).toContain("greet");
		// No new harness on reload — the conversation survives.
		expect(conversation.getEntries().filter((e) => e.type === "message").length).toBe(messagesBefore);
		await runtime.cleanup();
	});

	it("reports resource counts and load errors in the resource summary", async () => {
		const { runtime } = makeRuntime();
		await runtime.createConversation();

		const summary = runtime.getResourceSummary();
		expect(summary.extensions).toBeGreaterThanOrEqual(1);
		expect(summary.skills).toBeGreaterThanOrEqual(1);
		expect(summary.diagnostics).toEqual([]);

		writeFileSync(join(getAgentDir(AGENT), "extensions", "broken.ts"), BROKEN_EXTENSION_SOURCE, "utf-8");
		await runtime.reload();

		const afterReload = runtime.getResourceSummary();
		expect(afterReload.diagnostics.some((d) => d.type === "error" && d.message.includes("boom"))).toBe(true);
		await runtime.cleanup();
	});

	it("ships docs and plugins in the published package", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));
		expect(pkg.files).toContain("docs");
		expect(pkg.files).toContain("plugins");
	});

	it("queues a mid-stream sendUserMessage as a follow-up and answers in order", async () => {
		const { runtime, registration } = makeRuntime();
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const secondTurnUserText: string[] = [];
		registration.setResponses([
			async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
				return fauxAssistantMessage("first-answer");
			},
			(context) => {
				for (const message of context.messages) {
					if (message.role === "user") secondTurnUserText.push(messageText(message.content));
				}
				return fauxAssistantMessage("second-answer");
			},
		]);

		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => unhandled.push(err);
		process.on("unhandledRejection", onUnhandled);
		try {
			const conversation = await runtime.createConversation();

			// An idle send starts a turn.
			const firstTurn = conversation.sendUserMessage("first");
			await firstEntered.promise;
			expect(conversation.harness.isIdle).toBe(false);

			// The mid-stream send routes to followUp — it must resolve, not throw "busy".
			await expect(conversation.sendUserMessage("second", { deliverAs: "followUp" })).resolves.toBeUndefined();

			releaseFirst.resolve();
			await firstTurn;
			await conversation.harness.waitForIdle();

			// Both turns ran, in order: the follow-up "second" was delivered to a later turn.
			expect(registration.state.callCount).toBe(2);
			expect(secondTurnUserText).toContain("second");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
		await runtime.cleanup();
	});
});

/** Minimal awaitable barrier for ordering test steps around an in-flight turn. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Flatten a message content union (string | content blocks) to its text. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => (block && block.type === "text" ? block.text : "")).join("");
	}
	return "";
}
