/**
 * External tool resolution for grep/find.
 *
 * Mirrors the `ensureTool(name)` contract of `@opsyhq/coding-agent`'s
 * utils/tools-manager.ts so grep.ts/find.ts can be copied verbatim. The
 * deviation: pi auto-downloads ripgrep/fd into a managed bin dir; steward only
 * resolves them from PATH (no network/binary management). When the tool isn't
 * installed this returns null and the caller surfaces a clear error — the agent
 * can fall back to the bash tool.
 */

import { spawnSync } from "node:child_process";

/**
 * Resolve an external tool (e.g. "rg", "fd") to an executable path on PATH.
 * Returns null when it cannot be found. The second argument exists only for
 * signature compatibility with pi's `ensureTool(name, autoInstall)`.
 */
export async function ensureTool(name: string, _autoInstall = false): Promise<string | null> {
	const lookup = process.platform === "win32" ? "where" : "which";
	try {
		const result = spawnSync(lookup, [name], { encoding: "utf-8" });
		if (result.status === 0 && result.stdout) {
			const first = result.stdout.trim().split(/\r?\n/)[0];
			if (first) return first;
		}
	} catch {
		// Fall through to null.
	}
	return null;
}
