import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSoulPath } from "../src/config.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { readMemoryFile, SOUL_BUDGET } from "../src/core/memory.ts";
import { createDeployTool } from "../src/core/tools/deploy.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	AgentSettingsManager.createAgent({ name: "scribe" });
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("deploy tool", () => {
	it("writes purpose + SOUL.md but does NOT stamp deployedAt", async () => {
		const result = await createDeployTool("scribe").execute("call-1", {
			purpose: "keep the meeting minutes",
			soul: "I am the scribe. I keep clear, durable minutes.",
		});
		expect(result.details.applied).toBe(true);
		expect(result.details.bytes).toBeGreaterThan(0);

		// Purpose persisted to agent.json, SOUL.md written verbatim.
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("keep the meeting minutes");
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("I am the scribe");

		// The latch is the UI's to flip — the tool leaves the agent still forming.
		expect(AgentSettingsManager.create("scribe").getAgentDeployed()).toBe(false);
	});

	it("trims both fields before saving", async () => {
		await createDeployTool("scribe").execute("call-1", {
			purpose: "  do the thing  ",
			soul: "  soulful  ",
		});
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("do the thing");
		expect(readMemoryFile(getSoulPath("scribe"))).toBe("soulful");
	});

	it("rejects an empty purpose", async () => {
		const result = await createDeployTool("scribe").execute("call-1", { purpose: "   ", soul: "a soul" });
		expect(result.details.applied).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text" });
		// Nothing written.
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("");
		expect(readMemoryFile(getSoulPath("scribe"))).toBe("");
	});

	it("rejects an empty soul", async () => {
		const result = await createDeployTool("scribe").execute("call-1", { purpose: "a purpose", soul: "   " });
		expect(result.details.applied).toBe(false);
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("");
	});

	it("rejects a SOUL.md over budget", async () => {
		const result = await createDeployTool("scribe").execute("call-1", {
			purpose: "a purpose",
			soul: "x".repeat(SOUL_BUDGET + 1),
		});
		expect(result.details.applied).toBe(false);
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("");
		expect(readMemoryFile(getSoulPath("scribe"))).toBe("");
	});
});
