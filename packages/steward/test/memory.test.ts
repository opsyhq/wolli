import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@opsyhq/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMemoryPath, getUserMemoryPath } from "../src/config.ts";
import { createAgent } from "../src/core/agent-config.ts";
import { loadMemory, MEMORY_BUDGET, readMemoryFile, writeMemoryFile } from "../src/core/memory.ts";
import { createMemoryTool, type MemoryToolDetails } from "../src/core/tools/memory.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "notes" });
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

interface MemoryOp {
	file: "MEMORY" | "USER";
	op: "add" | "replace" | "remove";
	content?: string;
	match?: string;
}

function run(op: MemoryOp): Promise<AgentToolResult<MemoryToolDetails>> {
	return createMemoryTool("scribe").execute("call-1", op);
}

function firstText(result: AgentToolResult<MemoryToolDetails>): string {
	const block = result.content[0];
	return block.type === "text" ? block.text : "";
}

describe("memory tool", () => {
	it("adds a line to MEMORY.md", async () => {
		const result = await run({ file: "MEMORY", op: "add", content: "User prefers metric units." });
		expect(result.details.applied).toBe(true);
		expect(readMemoryFile(getMemoryPath("scribe"))).toContain("User prefers metric units.");
	});

	it("appends successive lines", async () => {
		await run({ file: "MEMORY", op: "add", content: "first" });
		await run({ file: "MEMORY", op: "add", content: "second" });
		expect(readMemoryFile(getMemoryPath("scribe"))).toBe("first\nsecond\n");
	});

	it("replaces a single matched line", async () => {
		await run({ file: "MEMORY", op: "add", content: "weight: 80kg" });
		await run({ file: "MEMORY", op: "add", content: "height: 180cm" });
		const result = await run({ file: "MEMORY", op: "replace", match: "weight:", content: "weight: 78kg" });
		expect(result.details.applied).toBe(true);
		const content = readMemoryFile(getMemoryPath("scribe"));
		expect(content).toContain("weight: 78kg");
		expect(content).not.toContain("80kg");
		expect(content).toContain("height: 180cm");
	});

	it("removes a single matched line", async () => {
		await run({ file: "MEMORY", op: "add", content: "temp note" });
		await run({ file: "MEMORY", op: "add", content: "keep me" });
		const result = await run({ file: "MEMORY", op: "remove", match: "temp note" });
		expect(result.details.applied).toBe(true);
		const content = readMemoryFile(getMemoryPath("scribe"));
		expect(content).not.toContain("temp note");
		expect(content).toContain("keep me");
	});

	it("reports ambiguous matches without writing", async () => {
		await run({ file: "MEMORY", op: "add", content: "note one" });
		await run({ file: "MEMORY", op: "add", content: "note two" });
		const before = readMemoryFile(getMemoryPath("scribe"));
		const result = await run({ file: "MEMORY", op: "remove", match: "note" });
		expect(result.details.applied).toBe(false);
		expect(firstText(result)).toMatch(/matches 2 lines/);
		expect(readMemoryFile(getMemoryPath("scribe"))).toBe(before);
	});

	it("reports a missing match without writing", async () => {
		const result = await run({ file: "MEMORY", op: "remove", match: "nonexistent" });
		expect(result.details.applied).toBe(false);
		expect(firstText(result)).toMatch(/No line/);
	});

	it("enforces the budget and writes nothing on overflow", async () => {
		const big = "x".repeat(MEMORY_BUDGET + 100);
		const result = await run({ file: "MEMORY", op: "add", content: big });
		expect(result.details.applied).toBe(false);
		expect(firstText(result)).toMatch(/over the .*budget/);
		expect(readMemoryFile(getMemoryPath("scribe"))).toBe("");
	});

	it("writes to USER.md when file is USER", async () => {
		await run({ file: "USER", op: "add", content: "name: Sam" });
		expect(readMemoryFile(getUserMemoryPath("scribe"))).toContain("name: Sam");
		expect(readMemoryFile(getMemoryPath("scribe"))).toBe("");
	});
});

describe("loadMemory", () => {
	it("returns empty strings for a fresh agent", () => {
		const memory = loadMemory("scribe");
		expect(memory.memory).toBe("");
		expect(memory.user).toBe("");
	});

	it("reads written content verbatim", () => {
		writeMemoryFile(getMemoryPath("scribe"), "remembered\n");
		writeMemoryFile(getUserMemoryPath("scribe"), "about user\n");
		const memory = loadMemory("scribe");
		expect(memory.memory).toBe("remembered\n");
		expect(memory.user).toBe("about user\n");
	});

	it("defensively truncates over-budget files", () => {
		writeMemoryFile(getMemoryPath("scribe"), "y".repeat(MEMORY_BUDGET + 500));
		const memory = loadMemory("scribe");
		expect(memory.memory.length).toBeLessThanOrEqual(MEMORY_BUDGET);
		expect(memory.memory).toContain("truncated");
	});
});
