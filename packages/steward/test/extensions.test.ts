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
import { SessionHost } from "../src/core/session-host.ts";
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

let home: string;
let sharedDir: string;
let markerDir: string;
const registrations: Array<{ unregister(): void }> = [];

function makeHost(): { host: SessionHost; registration: ReturnType<typeof registerFauxProvider> } {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const host = new SessionHost({
		name: AGENT,
		// Faux models are typed Model<string>; the host wants Model<Api> (Api is a
		// string supertype) — the cast bridges the faux test double to the real shape.
		model: registration.getModel() as unknown as Model<Api>,
		thinkingLevel: "off",
		authStorage: AuthStorage.create(join(sharedDir, "auth.json")),
	});
	return { host, registration };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-ext-home-"));
	sharedDir = mkdtempSync(join(tmpdir(), "steward-ext-shared-"));
	markerDir = mkdtempSync(join(tmpdir(), "steward-ext-marker-"));
	process.env.STEWARD_HOME = home;
	process.env.STEWARD_CODING_AGENT_DIR = sharedDir;
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
	delete process.env.STEWARD_CODING_AGENT_DIR;
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
		if (!assistant || assistant.type !== "message") throw new Error("no persisted assistant message");
		const content = assistant.message.content;
		const text = typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toBe("MUTATED_BY_EXTENSION");
	});

	it("invalidates the previous runner's ctx on newSession", async () => {
		const { host } = makeHost();
		await host.start({ fresh: true });

		const previousRunner = host.extensionRunner;
		// Live ctx works before the swap.
		expect(() => previousRunner.createContext().cwd).not.toThrow();

		await host.newSession();

		// After the swap the superseded runner is invalidated: any captured ctx goes stale.
		expect(() => previousRunner.createContext().cwd).toThrow(/stale/);
		// The host now exposes a fresh, live runner.
		expect(host.extensionRunner).not.toBe(previousRunner);
		expect(() => host.extensionRunner.createContext().cwd).not.toThrow();
		await host.cleanup();
	});
});
