/**
 * Path helpers.
 *
 * Mirrors `@opsyhq/coding-agent`'s utils/paths.ts `normalizePath`, kept to the
 * minimal subset auth-storage needs: tilde expansion and `file://` URLs. The
 * richer trim/unicode/at-prefix options of the full version are omitted.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Normalize a filesystem path: expand a leading `~` to the home dir and convert
 * `file://` URLs to paths. Already-absolute paths pass through unchanged.
 */
export function normalizePath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
		return join(homedir(), input.slice(2));
	}
	if (/^file:\/\//.test(input)) {
		return fileURLToPath(input);
	}
	return input;
}
