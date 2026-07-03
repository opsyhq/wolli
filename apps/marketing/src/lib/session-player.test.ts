import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSession } from "@/lib/session";
import { activeWriteFile, SessionPlayer, sessionToBlocks, type ToolBlock, writtenFiles } from "@/lib/session-player";

// End-to-end over the real curated demos: loader -> replay generator -> reducer.
// Asserts the fully-revealed transcript matches wolli's rendering rules (assistant
// bubbles carry text/thinking + toolCalls; each toolCall becomes a separate tool block
// after the bubble, filled by its matching toolResult).
const FORMING = readFileSync(join(process.cwd(), "public/sessions/forming.jsonl"), "utf-8");
const EXTENDING = readFileSync(join(process.cwd(), "public/sessions/extending.jsonl"), "utf-8");
const TRIGGERED = readFileSync(join(process.cwd(), "public/sessions/triggered.jsonl"), "utf-8");
const FORMING_BLOCKS = sessionToBlocks(loadSession(FORMING, "forming.jsonl").messages);

describe("sessionToBlocks (forming demo)", () => {
	const blocks = FORMING_BLOCKS;

	it("produces the expected block sequence", () => {
		expect(blocks.map((b) => b.kind)).toEqual(["assistant", "user", "assistant", "tool", "assistant"]);
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
		const write = blocks[3];
		expect(write.kind === "tool" && write.name).toBe("write");
		expect(write.kind === "tool" && write.isPartial).toBe(false);
		expect(write.kind === "tool" && (write.args as { path?: string }).path).toBe("SOUL.md");
		expect(write.kind === "tool" && write.result?.isError).toBe(false);
		expect(write.kind === "tool" && write.result?.content[0]?.text).toMatch(
			/^Successfully wrote \d+ bytes to SOUL\.md$/,
		);
	});
});

describe("sessionToBlocks (extending demo, continues forming)", () => {
	const formingBlocks = FORMING_BLOCKS;
	const extendingBlocks = sessionToBlocks(loadSession(EXTENDING, "extending.jsonl").messages);

	it("starts with forming's exact blocks, then continues the same session", () => {
		expect(extendingBlocks.length).toBeGreaterThan(formingBlocks.length);
		expect(extendingBlocks.slice(0, formingBlocks.length)).toEqual(formingBlocks);
	});

	it("adds the integration, workflow, and tool writes", () => {
		expect(writtenFiles(extendingBlocks)).toEqual([
			"SOUL.md",
			"integrations/github.ts",
			"workflows/on-issue-opened.ts",
			"tools/github.ts",
		]);
	});
});

describe("sessionToBlocks (triggered demo)", () => {
	const blocks = sessionToBlocks(loadSession(TRIGGERED, "triggered.jsonl").messages);

	it("opens with the delivered github event as a user block", () => {
		const first = blocks[0];
		expect(first.kind).toBe("user");
		expect(first.kind === "user" && first.text.startsWith("[github]")).toBe(true);
	});

	it("flags the issue through the github tool", () => {
		const flag = blocks.find((b) => b.kind === "tool" && b.name === "github");
		expect(flag?.kind === "tool" && (flag.args as { action?: string }).action).toBe("addLabels");
		expect(flag?.kind === "tool" && flag.result?.isError).toBe(false);
	});
});

describe("writtenFiles / activeWriteFile", () => {
	const formingBlocks = FORMING_BLOCKS;

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

	it("excludes partial, errored, and non-write tool blocks", () => {
		expect(writtenFiles([toolBlock({ isPartial: true, result: undefined })])).toEqual([]);
		expect(writtenFiles([toolBlock({ result: { content: [], isError: true } })])).toEqual([]);
		expect(writtenFiles([toolBlock({ name: "read", args: { path: "notes.md" } })])).toEqual([]);
	});

	it("highlights an in-flight write and nothing when there is none", () => {
		expect(activeWriteFile([toolBlock({ isPartial: true, result: undefined })])).toBe("notes.md");
		expect(activeWriteFile([])).toBeUndefined();
	});
});

describe("SessionPlayer", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(source: string | Record<string, string> = FORMING) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				text: async () => (typeof source === "string" ? source : (source[url] ?? "")),
			})),
		);
	}

	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("fold reveals the complete transcript instantly and settles the player", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		await player.fold(() => {});
		expect(player.status).toBe("done");
		expect(player.snapshot.blocks).toHaveLength(FORMING_BLOCKS.length);
	});

	it("a continuing player pre-folds its predecessor's transcript before any timed frame", async () => {
		stubFetch({ "/sessions/forming.jsonl": FORMING, "/sessions/extending.jsonl": EXTENDING });
		const formingBlocks = FORMING_BLOCKS;
		const forming = new SessionPlayer("/sessions/forming.jsonl");
		const player = new SessionPlayer("/sessions/extending.jsonl", forming);
		const snapshots: Array<{ blocks: unknown[]; input: string }> = [];
		const run = player.play((snapshot) => snapshots.push(snapshot));

		await wait(50);
		player.stop();
		await run;

		// The very first emit is the folded forming transcript, composer still empty.
		expect(snapshots[0]?.blocks).toHaveLength(formingBlocks.length);
		expect(snapshots[0]?.input).toBe("");
	});

	it("event deliveries land without composer typing", async () => {
		stubFetch(TRIGGERED);
		const player = new SessionPlayer("/sessions/triggered.jsonl");
		const snapshots: Array<{ blocks: Array<{ kind: string }>; input: string }> = [];
		const run = player.play((snapshot) => snapshots.push(snapshot));

		// agent_start + the submit beat precede the event landing (~420ms in).
		await wait(700);
		player.stop();
		await run;

		const landed = snapshots.find((snapshot) => snapshot.blocks.length > 0);
		expect(landed?.blocks[0]?.kind).toBe("user");
		expect(snapshots.every((snapshot) => snapshot.input === "")).toBe(true);
	});

	it("stop() ends the run and freezes the transcript where it was", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		const run = player.play(() => {});

		await wait(300);
		player.stop();
		await run;
		const frozen = player.snapshot;
		await wait(300);
		expect(player.snapshot).toBe(frozen); // no frames after stop
	});

	it("a repeat play() replays a finished section from the top", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		await player.fold(() => {});
		const full = player.snapshot.blocks.length;

		const snapshots: Array<{ blocks: unknown[] }> = [];
		const run = player.play((snapshot) => snapshots.push(snapshot));
		await wait(100);
		player.stop();
		await run;

		// The first emitted frame starts the transcript over, not on the done state.
		expect(player.status).toBe("playing");
		expect(snapshots[0]?.blocks.length).toBeLessThan(full);
	});

	it("a second play() aborts the first run and streams from the top", async () => {
		stubFetch();
		const player = new SessionPlayer("/sessions/forming.jsonl");
		const first = player.play(() => {});
		await wait(300);

		const snapshots: Array<{ blocks: unknown[] }> = [];
		const second = player.play((snapshot) => snapshots.push(snapshot));
		await first; // the first run exits on its aborted signal
		await wait(100);
		expect(snapshots.length).toBeGreaterThan(0); // the replay streams

		player.stop();
		await second;
	});
});
