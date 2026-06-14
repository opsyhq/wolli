/**
 * App identity and agent-home paths.
 *
 * Mirrors `@opsyhq/coding-agent`'s config.ts: the app name and config dir are
 * derived from package.json's `piConfig` block, and every on-disk location is a
 * `getXxxDir`/`getXxxPath` getter. Steward's getters are parameterized by agent
 * name because sessions/memory are keyed by agent, not by cwd.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

function getPackageJsonPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	let dir = moduleDir;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(moduleDir, "..", "package.json");
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@opsyhq/steward";
export const APP_NAME: string = piConfigName || "steward";
export const APP_TITLE: string = APP_NAME;
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".steward";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., STEWARD_HOME
export const ENV_HOME = `${APP_NAME.toUpperCase()}_HOME`;

// Override for the shared pi credential dir, e.g. STEWARD_CODING_AGENT_DIR.
// Mirrors `@opsyhq/coding-agent`'s ENV_AGENT_DIR so steward resolves the exact
// same `~/.steward/agent/` the pi CLI already wrote auth.json/settings.json into.
export const ENV_SHARED_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

// =============================================================================
// Packaged asset dirs (themes shipped with the package)
// =============================================================================

/** Dir containing this package's package.json (walks up from the module). */
export function getPackageDir(): string {
	return dirname(getPackageJsonPath());
}

/**
 * Built-in themes dir shipped with the package. In dev the theme sources live
 * under src/; once built they live under dist/. Mirrors pi's getThemesDir().
 */
export function getThemesDir(): string {
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/** User's custom themes dir, e.g. ~/.steward/agent/themes (shared pi agent dir). */
export function getCustomThemesDir(): string {
	return join(getSharedAgentDir(), "themes");
}

/** Path to this package's README.md. Used by the read tool's docs classification. */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

// =============================================================================
// Agent home paths (~/.steward/agents/<name>/)
// =============================================================================

/** Root config dir, e.g. ~/.steward (override with STEWARD_HOME). */
export function getHomeDir(): string {
	const envHome = process.env[ENV_HOME];
	if (envHome) return expandTildePath(envHome);
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Root dir holding all agents, e.g. ~/.steward/agents */
export function getAgentsRoot(): string {
	return join(getHomeDir(), "agents");
}

/** Per-agent home dir, e.g. ~/.steward/agents/<name> */
export function getAgentDir(name: string): string {
	return join(getAgentsRoot(), name);
}

/** Path to an agent's agent.json */
export function getAgentConfigPath(name: string): string {
	return join(getAgentDir(name), "agent.json");
}

/** Path to an agent's curated SOUL.md (who it is / what it's for). */
export function getSoulPath(name: string): string {
	return join(getAgentDir(name), "SOUL.md");
}

/** Path to an agent's curated MEMORY.md */
export function getMemoryPath(name: string): string {
	return join(getAgentDir(name), "MEMORY.md");
}

/** Path to an agent's curated USER.md */
export function getUserMemoryPath(name: string): string {
	return join(getAgentDir(name), "USER.md");
}

/** Path to an agent's sessions dir (JsonlSessionRepo sessionsRoot) */
export function getSessionsDir(name: string): string {
	return join(getAgentDir(name), "sessions");
}

/** Path to an agent's owned workspace (the stable cwd passed to the repo) */
export function getWorkspaceDir(name: string): string {
	return join(getAgentDir(name), "workspace");
}

// =============================================================================
// Shared pi credential store (~/.steward/agent/, written by the pi CLI)
// =============================================================================
//
// Steward reuses the credentials and default model that the pi CLI already set
// up, so a Codex OAuth login (or any env/api key) works with no re-login. These
// getters mirror `@opsyhq/coding-agent`'s `getAgentDir()`/`getAuthPath()`/
// `getSettingsPath()` (singular `agent`), distinct from steward's own per-agent
// homes under `agents/<name>/` (plural).

/** Shared pi agent dir, e.g. ~/.steward/agent (override with STEWARD_CODING_AGENT_DIR). */
export function getSharedAgentDir(): string {
	const envDir = process.env[ENV_SHARED_AGENT_DIR];
	if (envDir) return expandTildePath(envDir);
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Path to the shared auth.json (API keys + OAuth tokens). */
export function getAuthPath(): string {
	return join(getSharedAgentDir(), "auth.json");
}

/** Path to the shared settings.json (defaultProvider/defaultModel). */
export function getSettingsPath(): string {
	return join(getSharedAgentDir(), "settings.json");
}
