import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sessionToBlocks } from "@/hooks/use-session";
import { loadSession } from "@/lib/session";

// End-to-end over the real curated demo: loader -> replay generator -> reducer.
// Asserts the fully-revealed transcript matches wolli's rendering rules (assistant
// bubbles carry text/thinking + toolCalls; each toolCall becomes a separate tool block
// after the bubble, filled by its matching toolResult).
const CURATED = readFileSync(new URL("../../public/sessions/extend.jsonl", import.meta.url), "utf-8");

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
