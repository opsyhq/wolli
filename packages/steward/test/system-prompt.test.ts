import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent, loadAgentConfig } from "../src/core/agent-config.ts";
import { loadMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createMemoryTool } from "../src/core/tools/memory.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "Keep meeting notes" });
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
	it("includes the agent identity and purpose", () => {
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe") });
		expect(prompt).toContain("You are scribe");
		expect(prompt).toContain("Keep meeting notes");
	});

	it("omits the memory block when memory is empty", () => {
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe"), memory: "", user: "" });
		expect(prompt).not.toContain("Your memory");
	});

	it("includes a delimited, read-only memory block when present", () => {
		const prompt = buildSystemPrompt({
			config: loadAgentConfig("scribe"),
			memory: "remembered fact",
			user: "user fact",
		});
		expect(prompt).toContain("read-only this session");
		expect(prompt).toContain("effective next session");
		expect(prompt).toContain("### MEMORY.md");
		expect(prompt).toContain("remembered fact");
		expect(prompt).toContain("### USER.md");
		expect(prompt).toContain("user fact");
	});
});

describe("frozen-snapshot invariant", () => {
	it("keeps the built prompt stable after a mid-session memory write", async () => {
		const config = loadAgentConfig("scribe");

		// Session start: read memory ONCE and freeze it into the prompt.
		const snapshot = loadMemory("scribe");
		const frozenPrompt = buildSystemPrompt({ config, memory: snapshot.memory, user: snapshot.user });

		// Mid-session: the agent writes a new fact via the memory tool.
		const result = await createMemoryTool("scribe").execute("call-1", {
			file: "MEMORY",
			op: "add",
			content: "a brand new fact",
		});
		expect(result.details.applied).toBe(true);

		// The frozen prompt does NOT change (still byte-identical, no new fact).
		expect(frozenPrompt).not.toContain("a brand new fact");

		// But the next session's load reflects the durable write.
		const nextSession = loadMemory("scribe");
		expect(nextSession.memory).toContain("a brand new fact");
		const nextPrompt = buildSystemPrompt({ config, memory: nextSession.memory, user: nextSession.user });
		expect(nextPrompt).toContain("a brand new fact");
	});
});
