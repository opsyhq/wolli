import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@opsyhq/agent";
import { NodeExecutionEnv } from "@opsyhq/agent/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir, getSoulPath } from "../src/config.ts";
import { createAgent } from "../src/core/agent-config.ts";
import { readMemoryFile } from "../src/core/memory.ts";
import { type BashToolDetails, createBashTool } from "../src/core/tools/bash.ts";

let home: string;
let env: NodeExecutionEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "notes" });
	env = new NodeExecutionEnv({ cwd: getAgentDir("scribe") });
});

afterEach(async () => {
	await env.cleanup();
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

function run(command: string): Promise<AgentToolResult<BashToolDetails>> {
	return createBashTool(env, getAgentDir("scribe")).execute("call-1", { command });
}

function firstText(result: AgentToolResult<BashToolDetails>): string {
	const block = result.content[0];
	return block.type === "text" ? block.text : "";
}

describe("bash tool", () => {
	it("captures stdout and a zero exit code", async () => {
		const result = await run("echo hello");
		expect(firstText(result)).toContain("hello");
		expect(result.details.exitCode).toBe(0);
	});

	it("runs in the agent home, so SOUL.md is right there", async () => {
		// The newborn agent's curated files live in the cwd.
		const result = await run("ls");
		const text = firstText(result);
		expect(text).toContain("SOUL.md");
		expect(text).toContain("workspace");
	});

	it("rewrites its own SOUL.md (the bash-driven self-update)", async () => {
		await run("printf 'I am the scribe, keeper of notes.\\n' > SOUL.md");
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("keeper of notes");
	});

	it("surfaces a non-zero exit code without throwing", async () => {
		const result = await run("exit 3");
		expect(result.details.exitCode).toBe(3);
		expect(firstText(result)).toContain("[exit code 3]");
	});
});
