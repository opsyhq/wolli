/**
 * App identity and agent-home paths.
 *
 * The app name and config dir are derived from package.json's `piConfig` block,
 * and every on-disk location is a `getXxxDir`/`getXxxPath` getter. Steward's
 * getters are parameterized by agent name because sessions/memory are keyed by
 * agent, not by cwd.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * Detect if we're running as a Bun compiled binary.
 * Consumed by the extension loader to choose jiti virtualModules vs
 * aliases. Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN".
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

// e.g., STEWARD_HOME
export const ENV_HOME = `${APP_NAME.toUpperCase()}_HOME`;

// Override for the shared credential dir, e.g. STEWARD_SHARED_DIR.
// Resolves the shared `~/.steward/agent/` holding auth.json/settings.json.
export const ENV_SHARED_AGENT_DIR = `${APP_NAME.toUpperCase()}_SHARED_DIR`;

// Override for a daemon's bearer token, e.g. STEWARD_DAEMON_TOKEN. When set, the
// daemon authenticates with this value instead of the token persisted in agent.json.
export const ENV_DAEMON_TOKEN = `${APP_NAME.toUpperCase()}_DAEMON_TOKEN`;

// Override for the host the daemon binds, e.g. STEWARD_DAEMON_HOST. Defaults to loopback
// (`127.0.0.1`); set `0.0.0.0` to make the daemon reachable off-box (VPS use).
export const ENV_DAEMON_HOST = `${APP_NAME.toUpperCase()}_DAEMON_HOST`;

// Force the OS service backend, e.g. STEWARD_SERVICE_MANAGER=none|launchd|systemd. Overrides
// the platform autodetect — `none` keeps deploy from registering a real launchd/systemd unit
// (used in dev/CI so the deploy flow can be exercised without an OS-managed side effect).
export const ENV_SERVICE_MANAGER = `${APP_NAME.toUpperCase()}_SERVICE_MANAGER`;

// Select the file/shell confinement backend, e.g. STEWARD_SANDBOX=host|local-os|docker|auto (default `auto`).
// `auto` confines via srt (Apple Seatbelt / bubblewrap) on darwin/linux and falls back to the
// unconfined host on unsupported platforms or srt-init failure; `host` forces today's unconfined
// behavior; `local-os` forces the srt backend; `docker` runs bash inside a container (explicit
// opt-in only — `auto`/unset never spins up a container).
export const ENV_SANDBOX = `${APP_NAME.toUpperCase()}_SANDBOX`;

// Skip host-escalation prompts: STEWARD_BYPASS_PERMISSIONS=1 auto-approves every host command. The
// sandbox stays the default target; `host` is still a distinct target, its gate just never blocks.
// Loud opt-in only — the analog to `claude --dangerously-skip-permissions`.
export const ENV_BYPASS_PERMISSIONS = `${APP_NAME.toUpperCase()}_BYPASS_PERMISSIONS`;

export function bypassPermissions(): boolean {
	const v = process.env[ENV_BYPASS_PERMISSIONS]?.trim();
	return v === "1" || v === "true";
}

// Image for the docker sandbox backend, e.g. STEWARD_CONTAINER_IMAGE. Falls back to
// DEFAULT_CONTAINER_IMAGE when unset.
export const ENV_CONTAINER_IMAGE = `${APP_NAME.toUpperCase()}_CONTAINER_IMAGE`;

// Default image for the docker sandbox backend (STEWARD_SANDBOX=docker): a published multi-arch image
// = debian:stable-slim + ripgrep/fd (grep/find run them inside the container). Built and pushed from
// docker/sandbox.Dockerfile. Override with STEWARD_CONTAINER_IMAGE (used as-is, expected to carry rg+fd).
export const DEFAULT_CONTAINER_IMAGE = "ghcr.io/opsyhq/steward-sandbox:1";

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
 * under src/; once built they live under dist/.
 */
export function getThemesDir(): string {
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "theme");
}

/** User's custom themes dir, e.g. ~/.steward/agent/themes (shared agent dir). */
export function getCustomThemesDir(): string {
	return join(getSharedAgentDir(), "themes");
}

/** Path to this package's README.md. Used by the read tool's docs classification. */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Dir of bundled plugins shipped with the package (raw .ts, loaded via jiti once installed). */
export function getPluginsDir(): string {
	return resolve(join(getPackageDir(), "plugins"));
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

/** Path to an agent's integrations.json (per-agent `(service, account)` credential registry). */
export function getAgentIntegrationsPath(name: string): string {
	return join(getAgentDir(name), "integrations.json");
}

/** Path to an agent's auth.json (per-agent API keys + OAuth tokens; the agent credential tier). */
export function getAgentAuthPath(name: string): string {
	return join(getAgentDir(name), "auth.json");
}

/** Path to an agent's integrations dir (where installed integration packages are symlinked/discovered). */
export function getAgentIntegrationsDir(name: string): string {
	return join(getAgentDir(name), "integrations");
}

/** Path to an agent's per-integration runtime state dir, e.g. ~/.steward/agents/<name>/store */
export function getAgentStoreDir(name: string): string {
	return join(getAgentDir(name), "store");
}

/** Path to one integration's runtime state file, e.g. ~/.steward/agents/<name>/store/<service>.json */
export function getIntegrationStorePath(name: string, service: string): string {
	return join(getAgentStoreDir(name), `${service}.json`);
}

/** Path to an agent's approvals.json (durable host-escalation prefix rules). */
export function getAgentApprovalsPath(name: string): string {
	return join(getAgentDir(name), "approvals.json");
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
// Daemon runtime (host/token/logs)
// =============================================================================

/** Root dir for daemon log files (launchd/systemd stdout/stderr), e.g. $TMPDIR/steward-daemons. */
export function getDaemonRuntimeDir(): string {
	return join(tmpdir(), `${APP_NAME}-daemons`);
}

/** The host the daemon binds (STEWARD_DAEMON_HOST), defaulting to loopback. */
export function getDaemonHost(): string {
	return process.env[ENV_DAEMON_HOST]?.trim() || "127.0.0.1";
}

/** The STEWARD_DAEMON_TOKEN override, if set — callers fall back to the agent's persisted token. */
export function getDaemonToken(): string | undefined {
	return process.env[ENV_DAEMON_TOKEN]?.trim();
}

// =============================================================================
// Shared credential store (~/.steward/agent/)
// =============================================================================
//
// Steward reuses the credentials and default model in the shared `agent/` dir,
// so a Codex OAuth login (or any env/api key) works with no re-login. These
// resolve the singular shared `agent` dir, distinct from steward's own per-agent
// homes under `agents/<name>/` (plural).

/** Shared agent dir, e.g. ~/.steward/agent (override with STEWARD_SHARED_DIR). */
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

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getSharedAgentDir(), "bin");
}
