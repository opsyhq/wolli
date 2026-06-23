import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir, getSoulPath } from "../src/config.ts";
import { createAgent } from "../src/core/agent-config.ts";
import { createHostEnvironment, type Environment } from "../src/core/environments/index.ts";
import { readMemoryFile } from "../src/core/memory.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

/** grep/find shell out to ripgrep/fd; skip those cases when the binary is absent. */
function hasTool(name: string): boolean {
	const lookup = process.platform === "win32" ? "where" : "which";
	return spawnSync(lookup, [name]).status === 0;
}

let home: string;
let dir: string;
let env: Environment;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "notes" });
	dir = getAgentDir("scribe");
	env = createHostEnvironment(dir);
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

function firstText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && block.type === "text" ? (block.text ?? "") : "";
}

// The file tools are bound to the agent's home dir — the same wiring SessionHost
// uses. We assert they reach the agent's own files (SOUL.md) so a regression in
// cwd binding is caught.
describe("file tools bound to the agent home", () => {
	it("write → read round-trips SOUL.md", async () => {
		await createWriteTool(env).execute("c1", { path: "SOUL.md", content: "I am the scribe.\n" });
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("I am the scribe.");

		const read = await createReadTool(env).execute("c2", { path: "SOUL.md" });
		expect(firstText(read)).toContain("I am the scribe.");
	});

	it("edit replaces a unique block in SOUL.md", async () => {
		await createWriteTool(env).execute("c1", { path: "SOUL.md", content: "name: scribe\nrole: notes\n" });
		await createEditTool(env).execute("c2", {
			path: "SOUL.md",
			edits: [{ oldText: "role: notes", newText: "role: keeper of notes" }],
		});
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("keeper of notes");
	});

	it("ls lists the agent home, including SOUL.md and workspace/", async () => {
		const result = await createLsTool(env).execute("c1", {});
		const text = firstText(result);
		expect(text).toContain("SOUL.md");
		expect(text).toContain("workspace/");
	});

	it.runIf(hasTool("rg"))("grep finds a match in the agent's files", async () => {
		await createWriteTool(env).execute("c1", { path: "MEMORY.md", content: "prefers metric units\n" });
		const result = await createGrepTool(env).execute("c2", { pattern: "metric" });
		expect(firstText(result)).toContain("MEMORY.md");
		expect(firstText(result)).toContain("metric");
	});
});
