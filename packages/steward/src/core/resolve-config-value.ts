/**
 * Resolve configuration values that may be shell commands, environment
 * variables, or literals. Used by auth-storage.ts for `api_key` credentials.
 *
 * Mirrors `@opsyhq/coding-agent`'s `resolveConfigValue` (same name/contract),
 * trimmed to the cases steward needs: a leading `!` runs the rest as a shell
 * command (stdout), `$VAR`/`${VAR}` interpolate env vars (missing → undefined),
 * and `$$`/`$!` escape a literal `$`/`!`. Anything else is a literal.
 */

import { execSync } from "node:child_process";

const REFERENCE_RE = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		try {
			const output = execSync(config.slice(1), {
				encoding: "utf-8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return output.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	let missing = false;
	const resolved = config.replace(REFERENCE_RE, (match, braced: string, bare: string) => {
		if (match === "$$") return "$";
		if (match === "$!") return "!";
		const value = process.env[braced ?? bare];
		if (!value) {
			missing = true;
			return "";
		}
		return value;
	});

	return missing ? undefined : resolved;
}
