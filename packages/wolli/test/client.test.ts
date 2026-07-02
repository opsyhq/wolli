import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/client.ts";
import { getSoulPath } from "../src/config.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { writeMemoryFile } from "../src/core/memory.ts";

let home: string;
let agent: Agent;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "wolli-test-"));
	process.env.WOLLI_HOME = home;
	agent = new Agent(AgentSettingsManager.createAgent({ name: "scribe" }).config);
});

afterEach(() => {
	delete process.env.WOLLI_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("Agent.getPurpose", () => {
	it("returns '' for an empty or absent SOUL.md", () => {
		expect(agent.getPurpose()).toBe("");
	});

	it("strips a leading heading mark", () => {
		writeMemoryFile(getSoulPath("scribe"), "# Track my calories\nMore body text.\n");
		expect(agent.getPurpose()).toBe("Track my calories");
	});

	it("skips blank leading lines", () => {
		writeMemoryFile(getSoulPath("scribe"), "\n   \nKeep the meeting minutes\n");
		expect(agent.getPurpose()).toBe("Keep the meeting minutes");
	});

	it("collapses internal whitespace", () => {
		writeMemoryFile(getSoulPath("scribe"), "Track  my\tcalories  \n");
		expect(agent.getPurpose()).toBe("Track my calories");
	});
});
