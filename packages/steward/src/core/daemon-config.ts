/**
 * Daemon runtime config.
 *
 * Ephemeral handshake state the daemon writes to the OS temp dir so clients can find the running
 * server: the `port` it bound, the bearer `token` for `/events` + `/control`, and the owning `pid`.
 * A discovery hint, not a lock: clients validate it via `/health` before trusting it, so a stale
 * entry is harmless — it's overwritten by the next daemon start and removed when the agent is
 * deleted. Gone on reboot. This is the sole record of a daemon's port: nothing is reserved up
 * front, so the agent's identity is its name (the config filename), not a fixed port.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDaemonPath } from "../config.ts";

export interface DaemonConfig {
	/** PID of the daemon process (so a client can detect a stale config). */
	pid: number;
	/** Loopback port the HTTP/SSE server bound this run. */
	port: number;
	/** Bearer token authenticating `/events` + `/control`. */
	token: string;
	/** ISO timestamp the daemon started. */
	startedAt: string;
	/** Steward version that wrote it. */
	version: string;
}

/**
 * Write an agent's daemon config, creating the runtime dir if needed. The token is a loopback
 * bearer secret, so the file is owner-only (chmod 600) and written via a temp file + atomic rename
 * so a concurrent reader never sees a half-written file.
 */
export function saveDaemonConfig(name: string, cfg: DaemonConfig): void {
	const path = getAgentDaemonPath(name);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, path);
}

/** Read an agent's daemon config, or undefined when no daemon is recorded. */
export function loadDaemonConfig(name: string): DaemonConfig | undefined {
	const path = getAgentDaemonPath(name);
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf-8")) as DaemonConfig;
}

/** Remove an agent's daemon config (best-effort; no-op when absent). */
export function deleteDaemonConfig(name: string): void {
	rmSync(getAgentDaemonPath(name), { force: true });
}
