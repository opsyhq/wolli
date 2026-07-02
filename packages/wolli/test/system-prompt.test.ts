import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuiltInSkillsDir, getPluginsDir } from "../src/config.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { loadMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createMemoryTool } from "../src/core/tools/memory.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "wolli-test-"));
	process.env.WOLLI_HOME = home;
	AgentSettingsManager.createAgent({ name: "scribe" });
});

afterEach(() => {
	delete process.env.WOLLI_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
	it("includes the agent identity and no purpose line", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("You are scribe");
		expect(prompt).not.toContain("Your purpose:");
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

describe("onboarding instruction", () => {
	it("appends the onboarding block while SOUL.md is empty", () => {
		for (const soul of ["", "   \n\t\n", undefined]) {
			const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config, soul });
			expect(prompt).toContain("your SOUL.md is empty");
			expect(prompt).toContain("write SOUL.md yourself with the file tools");
		}
	});

	it("gates settling on a purpose on being able to do the job", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("make sure you can actually do the job");
		expect(prompt).toContain("never settle into a purpose you have no way to fulfill");
	});

	it("omits the onboarding block once SOUL.md has content", () => {
		const prompt = buildSystemPrompt({
			config: AgentSettingsManager.create("scribe").config,
			soul: "I am the scribe",
		});
		expect(prompt).not.toContain("your SOUL.md is empty");
		expect(prompt).toContain("## Extending yourself");
	});
});

describe("always-on guidance", () => {
	it("includes the Extending yourself block with and without a SOUL.md", () => {
		const onboarding = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(onboarding).toContain("## Extending yourself");

		const settled = buildSystemPrompt({
			config: AgentSettingsManager.create("scribe").config,
			soul: "I am the scribe",
		});
		expect(settled).toContain("## Extending yourself");
	});

	it("enumerates the full doc set", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("docs/extensions.md");
		expect(prompt).toContain("docs/integrations.md");
		expect(prompt).toContain("docs/skills.md");
		expect(prompt).toContain("docs/prompt-templates.md");
		expect(prompt).toContain("docs/themes.md");
		expect(prompt).toContain("docs/plugins.md");
		expect(prompt).toContain("docs/sdk.md");
	});

	it("points at the bundled plugins folder", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("Bundled plugins ready to install");
		expect(prompt).toContain(getPluginsDir());
	});

	it("points at the built-in skills folder and how to install one", () => {
		const prompt = buildSystemPrompt({ config: AgentSettingsManager.create("scribe").config });
		expect(prompt).toContain("Built-in skills ready to install");
		expect(prompt).toContain(getBuiltInSkillsDir());
		expect(prompt).toContain("cp -r");
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
