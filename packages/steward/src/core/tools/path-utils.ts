/**
 * Path resolution for the file tools.
 *
 * Mirrors `@opsyhq/coding-agent`'s core/tools/path-utils.ts `resolveToCwd`. The
 * macOS screenshot-path fallbacks (NFD / narrow-no-break-space / curly-quote
 * variants) from the original are intentionally omitted — steward's agents
 * address their own workspace files, not user-supplied screenshot paths.
 */

import { resolvePath } from "../../utils/paths.ts";

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}
