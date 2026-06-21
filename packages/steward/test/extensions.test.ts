/**
 * Extension-subsystem integration: the four functional checks the Tier 5 wiring
 * (SessionHost.build) exists to deliver. Each builds a REAL SessionHost against a
 * temp agent home + a faux pi-ai provider (no network), so the whole seam runs:
 * discovery → load → runner → frozen prompt → tool registration → core binding →
 * event translation.
 *
 *  1. discovered skills are frozen into the system prompt the harness sends;
 *  2. an extension's registerTool reaches the harness AND its session_start
 *     lifecycle handler fires during build;
 *  3. an extension's message_end mutation is applied in place and persisted;
 *  4. newSession() invalidates the superseded runner (its ctx goes stale).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { createAgent } from "../src/core/agent-config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { convertToLlm, createBashExecutionMessage } from "../src/core/messages.ts";
import { openAgentSession } from "../src/core/session.ts";
import { SessionHost } from "../src/core/session-host.ts";

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

function makeHost(): { host: SessionHost; registration: ReturnType<typeof registerFauxProvider> } {
	const registration = registerFauxProvider();
	registrations.push(registration);
	// Faux models are typed Model<string>; the host wants Model<Api> (Api is a
	// string supertype) — the cast bridges the faux test double to the real shape.
	const model = registration.getModel() as unknown as Model<Api>;
	const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
	// Request-time auth routes through ModelRegistry, which requires a resolvable API
	// key; the faux provider has none, so inject a runtime override (stands in for a
	// real provider being authed).
	authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
	const host = new SessionHost({
		name: AGENT,
		model,
		authStorage,
		integrationAccounts: IntegrationAccountStorage.inMemory(),
	});
	return { host, registration };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-ext-home-"));
	sharedDir = mkdtempSync(join(tmpdir(), "steward-ext-shared-"));
	markerDir = mkdtempSync(join(tmpdir(), "steward-ext-marker-"));
	process.env.STEWARD_HOME = home;
	process.env.STEWARD_SHARED_DIR = sharedDir;
	process.env.STEWARD_TEST_MARKER_DIR = markerDir;

	createAgent({ name: AGENT });

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
		const { host, registration } = makeHost();
		let capturedSystemPrompt = "";
		registration.setResponses([
			(context) => {
				capturedSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);

		await host.start({ fresh: true });
		await host.harness.prompt("hello");

		expect(capturedSystemPrompt).toContain("<available_skills>");
		expect(capturedSystemPrompt).toContain("note-taking");
		await host.cleanup();
	});

	it("registers extension tools on the harness and fires session_start during build", async () => {
		const { host } = makeHost();

		await host.start({ fresh: true });

		// registerTool reached the harness alongside the built-ins.
		expect(host.harness.getTools().map((tool) => tool.name)).toContain("test_echo");

		// session_start fired with reason "new" (fresh build) — recorded by the extension.
		const marker = JSON.parse(readFileSync(join(markerDir, "session_start.json"), "utf-8"));
		expect(marker).toEqual({ reason: "new" });
		await host.cleanup();
	});

	it("applies and persists a message_end mutation", async () => {
		const { host, registration } = makeHost();
		registration.setResponses([() => fauxAssistantMessage("original assistant text")]);

		await host.start({ fresh: true });
		await host.harness.prompt("hello");
		await host.cleanup();

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

	it("invalidates the previous runner's ctx on newSession", async () => {
		const { host } = makeHost();
		await host.start({ fresh: true });

		const previousRunner = host.extensionRunner;
		// Live ctx works before the swap.
		expect(() => previousRunner.createContext().cwd).not.toThrow();

		// "deploy" reason: this test exercises the runner swap, not the forming guard,
		// so it uses the intent that is always permitted out of any session.
		await host.newSession({ reason: "deploy" });

		// After the swap the superseded runner is invalidated: any captured ctx goes stale.
		expect(() => previousRunner.createContext().cwd).toThrow(/stale/);
		// The host now exposes a fresh, live runner.
		expect(host.extensionRunner).not.toBe(previousRunner);
		expect(() => host.extensionRunner.createContext().cwd).not.toThrow();
		await host.cleanup();
	});

	it("runs an extension command and does not reach the model", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "cmd-ext.ts"), COMMAND_EXTENSION_SOURCE, "utf-8");
		const { host, registration } = makeHost();
		await host.start({ fresh: true });

		await host.prompt("/greet there");

		const marker = JSON.parse(readFileSync(join(markerDir, "command.json"), "utf-8"));
		expect(marker).toEqual({ args: "there" });
		// The command handled the input itself — no model turn ran.
		expect(registration.state.callCount).toBe(0);
		await host.cleanup();
	});

	it("applies an input transform and short-circuits a handled input", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "input-ext.ts"), INPUT_EXTENSION_SOURCE, "utf-8");
		const { host, registration } = makeHost();
		let capturedUserText = "";
		registration.setResponses([
			(context) => {
				const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
				capturedUserText = lastUser ? messageText(lastUser.content) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await host.start({ fresh: true });

		// "raw" is rewritten before reaching the model.
		await host.prompt("raw");
		expect(capturedUserText).toBe("transformed");

		// "skipme" is fully handled by the extension — no further model turn.
		const callsBefore = registration.state.callCount;
		await host.prompt("skipme");
		expect(registration.state.callCount).toBe(callsBefore);
		await host.cleanup();
	});

	it("lets an extension handle user_bash and returns its result", async () => {
		writeFileSync(join(getAgentDir(AGENT), "extensions", "bash-ext.ts"), USER_BASH_EXTENSION_SOURCE, "utf-8");
		const { host } = makeHost();
		await host.start({ fresh: true });

		const result = await host.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "echo hi",
			excludeFromContext: false,
			cwd: host.getCwd(),
		});

		expect(result?.result?.output).toBe("intercepted:echo hi");
		await host.cleanup();
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
		const { host, registration } = makeHost();
		registration.setResponses([() => fauxAssistantMessage("hi there")]);
		await host.start({ fresh: true });
		await host.prompt("hello");

		const messagesBefore = host.getEntries().filter((e) => e.type === "message").length;
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

		await host.reload();

		const commandNames = host.getCommands().map((c) => c.name);
		expect(commandNames).toContain("skill:research");
		expect(commandNames).toContain("summarize");
		expect(commandNames).toContain("greet");
		// No new harness on reload — the conversation survives.
		expect(host.getEntries().filter((e) => e.type === "message").length).toBe(messagesBefore);
		await host.cleanup();
	});

	it("reports resource counts and load errors in the resource summary", async () => {
		const { host } = makeHost();
		await host.start({ fresh: true });

		const summary = host.getResourceSummary();
		expect(summary.extensions).toBeGreaterThanOrEqual(1);
		expect(summary.skills).toBeGreaterThanOrEqual(1);
		expect(summary.diagnostics).toEqual([]);

		writeFileSync(join(getAgentDir(AGENT), "extensions", "broken.ts"), BROKEN_EXTENSION_SOURCE, "utf-8");
		await host.reload();

		const afterReload = host.getResourceSummary();
		expect(afterReload.diagnostics.some((d) => d.type === "error" && d.message.includes("boom"))).toBe(true);
		await host.cleanup();
	});

	it("ships docs and examples in the published package", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));
		expect(pkg.files).toContain("docs");
		expect(pkg.files).toContain("examples");
	});

	it("queues a mid-stream sendUserMessage as a follow-up and answers in order", async () => {
		const { host, registration } = makeHost();
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
			await host.start({ fresh: true });

			// An idle send starts a turn.
			const firstTurn = host.sendUserMessage("first");
			await firstEntered.promise;
			expect(host.harness.isIdle).toBe(false);

			// The mid-stream send routes to followUp — it must resolve, not throw "busy".
			await expect(host.sendUserMessage("second", { deliverAs: "followUp" })).resolves.toBeUndefined();

			releaseFirst.resolve();
			await firstTurn;
			await host.harness.waitForIdle();

			// Both turns ran, in order: the follow-up "second" was delivered to a later turn.
			expect(registration.state.callCount).toBe(2);
			expect(secondTurnUserText).toContain("second");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
		await host.cleanup();
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
