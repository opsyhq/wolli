// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSessionPlaylist } from "@/hooks/use-session-playlist";
import { loadSession } from "@/lib/session";
import { sessionToBlocks } from "@/lib/session-player";

// (cwd-relative because jsdom rewrites import.meta.url to an http URL.)
const FORMING = readFileSync(join(process.cwd(), "public/sessions/forming.jsonl"), "utf-8");

describe("useSessionPlaylist", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("folds a skipped section to its full transcript and plays the activated one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, text: async () => FORMING })),
		);
		const foldedCount = sessionToBlocks(loadSession(FORMING, "forming.jsonl").messages).length;

		const { result, unmount } = renderHook(() => useSessionPlaylist(["/sessions/one.jsonl", "/sessions/two.jsonl"]));
		expect(result.current.sections.map((s) => s.status)).toEqual(["idle", "idle"]);
		expect(result.current.activeIndex).toBe(-1);

		// Fast-scroll straight past section 0: it must fold instantly (skip-to-folded policy)
		// while section 1 starts playing.
		act(() => result.current.activate(1));

		await waitFor(() => {
			expect(result.current.sections[0]!.status).toBe("done");
			expect(result.current.sections[0]!.blocks).toHaveLength(foldedCount);
			expect(result.current.sections[1]!.status).toBe("playing");
		});
		expect(result.current.activeIndex).toBe(1);

		unmount();
	});
});
