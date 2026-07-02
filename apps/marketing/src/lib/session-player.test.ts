import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSession } from "@/lib/session";
import { activeWriteFile, SessionPlayer, sessionToBlocks, type ToolBlock, writtenFiles } from "@/lib/session-player";

// End-to-end over the real curated demos: loader -> replay generator -> reducer.
// Asserts the fully-revealed transcript matches wolli's rendering rules (assistant
// bubbles carry text/thinking + toolCalls; each toolCall becomes a separate tool block
// after the bubble, filled by its matching toolResult).
const CURATED = readFileSync(join(process.cwd(), "public/sessions/extend.jsonl"), "utf-8");
const FORMING = readFileSync(join(process.cwd(), "public/sessions/forming.jsonl"), "utf-8");

describe("sessionToBlocks (curated demo)", () => {
	const blocks = sessionToBlocks(loadSession(CURATED, "extend.jsonl").messages);

	it("produces the expected block sequence", () => {
		expect(blocks.map((b) => b.kind)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"tool",
			"tool",
			"assistant",
		]);
	});

	it("opens the arc with the user's question", () => {
		const first = blocks[0];
		expect(first.kind).toBe("user");
		expect(first.kind === "user" && first.text.toLowerCase()).toContain("extend yourself");
	});

	it("renders read then ls as settled, successful tool blocks", () => {
		const read = blocks[4];
		const ls = blocks[5];
		expect(read.kind === "tool" && read.name).toBe("read");
		expect(read.kind === "tool" && read.isPartial).toBe(false);
		expect(read.kind === "tool" && read.result?.isError).toBe(false);
		expect(ls.kind === "tool" && ls.name).toBe("ls");
		expect(ls.kind === "tool" && ls.result?.isError).toBe(false);
	});

	it("keeps toolCall blocks in the assistant message that requested them", () => {
		const assistant = blocks[3];
		const toolCalls =
			assistant.kind === "assistant" ? assistant.message.content.filter((c) => c.type === "toolCall").length : 0;
		expect(toolCalls).toBe(2);
	});
});

describe("sessionToBlocks (forming demo)", () => {
	const blocks = sessionToBlocks(loadSession(FORMING, "forming.jsonl").messages);

	it("produces the expected block sequence", () => {
		expect(blocks.map((b) => b.kind)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
	});

	// Doubles as the leading-assistant regression check: a session may open with a seeded
	// assistant message (BIRTH_OPENER) and replay must not open a run around it.
	it("opens with the birth opener as an assistant bubble", () => {
		const first = blocks[0];
		expect(first.kind).toBe("assistant");
		const text = first.kind === "assistant" ? first.message.content.find((c) => c.type === "text") : undefined;
		expect(text?.type === "text" && text.text).toBe("What is my purpose?");
	});

	it("renders the SOUL.md write as a settled, successful tool block", () => {
		const write = blocks[5];
		expect(write.kind === "tool" && write.name).toBe("write");
		expect(write.kind === "tool" && write.isPartial).toBe(false);
		expect(write.kind === "tool" && (write.args as { path?: string }).path).toBe("SOUL.md");
		expect(write.kind === "tool" && write.result?.isError).toBe(false);
		expect(write.kind === "tool" && write.result?.content[0]?.text).toBe("Successfully wrote 298 bytes to SOUL.md");
	});
});

describe("writtenFiles / activeWriteFile", () => {
	const formingBlocks = sessionToBlocks(loadSession(FORMING, "forming.jsonl").messages);
	const extendBlocks = sessionToBlocks(loadSession(CURATED, "extend.jsonl").messages);

	function toolBlock(overrides: Partial<ToolBlock>): ToolBlock {
		return {
			kind: "tool",
			key: "t0",
			toolCallId: "call_1",
			name: "write",
			args: { path: "notes.md", content: "hi" },
			result: { content: [{ type: "text", text: "ok" }], isError: false },
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			...overrides,
		};
	}

	it("derives the forming session's writes from its transcript", () => {
		expect(writtenFiles(formingBlocks)).toEqual(["SOUL.md"]);
	});

	it("derives nothing from a session that only reads (guards against invented files)", () => {
		expect(writtenFiles(extendBlocks)).toEqual([]);
	});

	it("excludes partial, errored, and non-write tool blocks", () => {
		expect(writtenFiles([toolBlock({ isPartial: true, result: undefined })])).toEqual([]);
		expect(writtenFiles([toolBlock({ result: { content: [], isError: true } })])).toEqual([]);
		expect(writtenFiles([toolBlock({ name: "read", args: { path: "notes.md" } })])).toEqual([]);
	});

	it("highlights an in-flight write and nothing when there is none", () => {
		expect(activeWriteFile([toolBlock({ isPartial: true, result: undefined })])).toBe("notes.md");
		expect(activeWriteFile(extendBlocks)).toBeUndefined();
		expect(activeWriteFile([])).toBeUndefined();
	});
});

describe("SessionPlayer", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch() {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, text: async () => FORMING })),
		);
	}

	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("fold reveals the complete transcript instantly and settles the player", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		await player.fold(() => {});
		expect(player.status).toBe("done");
		expect(player.snapshot.blocks).toHaveLength(
			sessionToBlocks(loadSession(FORMING, "forming.jsonl").messages).length,
		);
	});

	it("pause freezes the driver between frames; resume continues where it froze", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		const controller = new AbortController();
		const run = player.play(() => {}, controller.signal);

		// Let a few frames land, pause, then let the in-flight frame's sleep drain
		// (longest eventCost is 600ms) — after that the loop is parked before emit.
		await wait(300);
		player.pause();
		await wait(800);
		const frozen = player.snapshot;
		await wait(500);
		expect(player.snapshot).toBe(frozen); // no frames emitted while paused
		expect(player.status).toBe("playing"); // paused, not done

		player.resume();
		await wait(400);
		expect(player.snapshot).not.toBe(frozen); // frames flow again

		controller.abort();
		await run;
	});
});
