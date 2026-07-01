import { describe, expect, it } from "vitest";

import { loadSession } from "@/lib/session";

const HEADER = {
	type: "session",
	version: 3,
	id: "test-0001",
	timestamp: "2026-06-16T08:52:40.000Z",
	cwd: "~/.wolli/agents/ricky2/workspace",
};

function jsonl(...entries: unknown[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function messageEntry(id: string, parentId: string | null, message: unknown) {
	return { type: "message", id, parentId, timestamp: HEADER.timestamp, message };
}

describe("loadSession", () => {
	it("reconstructs user -> assistant(toolCall) -> toolResult in order", () => {
		const fixture = jsonl(
			HEADER,
			messageEntry("e0", null, { role: "user", content: "extend yourself?", timestamp: 1 }),
			messageEntry("e1", "e0", {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the docs." },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "docs/extensions.md" } },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-opus-4-5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				stopReason: "toolUse",
				timestamp: 2,
			}),
			messageEntry("e2", "e1", {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "# Extensions" }],
				isError: false,
				timestamp: 3,
			}),
		);

		const context = loadSession(fixture);

		expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = context.messages[1];
		expect(assistant.role === "assistant" && assistant.content.some((c) => c.type === "toolCall")).toBe(true);
		// buildSessionContext derives the model from the last assistant message.
		expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-opus-4-5" });
	});

	it("follows only the selected branch (getPathToRoot via a leaf entry)", () => {
		const fixture = jsonl(
			HEADER,
			messageEntry("e0", null, { role: "user", content: "root", timestamp: 1 }),
			// Two sibling assistant replies branching off the root.
			messageEntry("e1", "e0", {
				role: "assistant",
				content: [{ type: "text", text: "branch A" }],
				api: "anthropic",
				provider: "anthropic",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				stopReason: "stop",
				timestamp: 2,
			}),
			messageEntry("e2", "e0", {
				role: "assistant",
				content: [{ type: "text", text: "branch B" }],
				api: "anthropic",
				provider: "anthropic",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				stopReason: "stop",
				timestamp: 3,
			}),
			// A leaf entry points the active branch back at e1, so e2 must be excluded.
			{ type: "leaf", id: "l0", parentId: "e2", timestamp: HEADER.timestamp, targetId: "e1" },
		);

		const context = loadSession(fixture);

		const texts = context.messages.map((m) =>
			m.role === "assistant" && m.content[0]?.type === "text" ? m.content[0].text : m.role,
		);
		expect(texts).toEqual(["user", "branch A"]);
	});
});
