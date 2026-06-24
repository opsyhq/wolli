import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { loadMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createMemoryTool } from "../src/core/tools/memory.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	AgentSettingsManager.createAgent({ name: "scribe", purpose: "Keep meeting notes" });
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
	it("includes the agent identity and purpose", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("You are scribe");
		expect(prompt).toContain("Keep meeting notes");
	});

	it("always renders the curated-file sections, empty marked", () => {
		const prompt = buildSystemPrompt({
			config: AgentSettingsManager.create("scribe").config,
			soul: "",
			memory: "",
			user: "",
		});
		expect(prompt).toContain("### SOUL.md");
		expect(prompt).toContain("### MEMORY.md");
		expect(prompt).toContain("### USER.md");
		expect(prompt).toContain("(empty)");
	});

	it("includes a delimited, read-only curated block with content when present", () => {
		const prompt = buildSystemPrompt({
			config: AgentSettingsManager.create("scribe").config,
			soul: "I am the scribe",
			memory: "remembered fact",
			user: "user fact",
		});
		expect(prompt).toContain("read-only this session");
		expect(prompt).toContain("effective next session");
		expect(prompt).toContain("### SOUL.md");
		expect(prompt).toContain("I am the scribe");
		expect(prompt).toContain("### MEMORY.md");
		expect(prompt).toContain("remembered fact");
		expect(prompt).toContain("### USER.md");
		expect(prompt).toContain("user fact");
	});

	it("appends appendSystemPrompt text at the end", () => {
		const base = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		const prompt = buildSystemPrompt({
			config: AgentSettingsManager.create("scribe").config,
			appendSystemPrompt: "Always answer in haiku.",
		});
		expect(prompt).toContain("Always answer in haiku.");
		expect(prompt.endsWith("Always answer in haiku.")).toBe(true);
		expect(prompt).toBe(`${base}\n\nAlways answer in haiku.`);
	});
});

describe("birth instruction (deploy)", () => {
	it("appends the birth instruction when not yet deployed", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("not yet deployed");
		expect(prompt).toContain("`deploy` tool");
		expect(prompt).toContain("/deploy");
	});

	it("omits the birth instruction once deployed", () => {
		AgentSettingsManager.create("scribe").setAgentDeployed();
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).not.toContain("not yet deployed");
		expect(prompt).toContain("deployed: you may now act");
	});
});

describe("frozen-snapshot invariant", () => {
	it("keeps the built prompt stable after a mid-session memory write", async () => {
		const config = AgentSettingsManager.create("scribe").config;

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
