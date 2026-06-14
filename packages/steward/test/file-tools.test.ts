import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createReadTool, createWriteTool } from "@opsyhq/coding-agent/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir, getSoulPath } from "../src/config.ts";
import { createAgent } from "../src/core/agent-config.ts";
import { readMemoryFile } from "../src/core/memory.ts";

let home: string;
let dir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "notes" });
	dir = getAgentDir("scribe");
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

function firstText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && block.type === "text" ? (block.text ?? "") : "";
}

// These are pi's exact tools (from @opsyhq/coding-agent/tools), bound to the
// agent's home dir — the same wiring SessionHost uses. We assert they reach the
// agent's own files (SOUL.md) so a regression in cwd binding is caught.
describe("pi file tools bound to the agent home", () => {
	it("write → read round-trips SOUL.md", async () => {
		await createWriteTool(dir).execute("c1", { path: "SOUL.md", content: "I am the scribe.\n" });
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("I am the scribe.");

		const read = await createReadTool(dir).execute("c2", { path: "SOUL.md" });
		expect(firstText(read)).toContain("I am the scribe.");
	});

	it("edit replaces a unique block in SOUL.md", async () => {
		await createWriteTool(dir).execute("c1", { path: "SOUL.md", content: "name: scribe\nrole: notes\n" });
		await createEditTool(dir).execute("c2", {
			path: "SOUL.md",
			edits: [{ oldText: "role: notes", newText: "role: keeper of notes" }],
		});
		expect(readMemoryFile(getSoulPath("scribe"))).toContain("keeper of notes");
	});
});
