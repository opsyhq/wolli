/**
 * Path helpers.
 *
 * `normalizePath`/`resolvePath` are copied from `@opsyhq/coding-agent`'s
 * utils/paths.ts, kept to the subset steward uses (auth-storage and the file
 * tools). The richer canonicalize / cloud-sync / relative-path helpers of the
 * full version are omitted.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}
