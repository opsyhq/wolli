/**
 * Daemon descriptor (`daemon.json`).
 *
 * A write-once handshake file the daemon drops into its agent home so attach clients can
 * find the running server: the `port` it bound, the bearer `token` for `/events` + `/control`,
 * and the owning `pid`. Written at start, removed at shutdown.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDaemonPath, getAgentDir } from "../config.ts";

export interface DaemonDescriptor {
	/** PID of the daemon process (so a client can detect a stale descriptor). */
	pid: number;
	/** Loopback port the HTTP/SSE server bound. */
	port: number;
	/** Bearer token authenticating `/events` + `/control`. */
	token: string;
	/** ISO timestamp the daemon started. */
	startedAt: string;
	/** Steward version that wrote the descriptor. */
	version: string;
}

/** Mint a fresh bearer token for a daemon (256 bits, hex-encoded). */
export function mintDaemonToken(): string {
	return randomBytes(32).toString("hex");
}

/** Write an agent's daemon descriptor, creating the agent home dir if needed. */
export function saveDaemonDescriptor(name: string, desc: DaemonDescriptor): void {
	mkdirSync(getAgentDir(name), { recursive: true });
	writeFileSync(getAgentDaemonPath(name), `${JSON.stringify(desc, null, 2)}\n`, "utf-8");
}

/** Read an agent's daemon descriptor, or undefined when no daemon is recorded. */
export function loadDaemonDescriptor(name: string): DaemonDescriptor | undefined {
	const path = getAgentDaemonPath(name);
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf-8")) as DaemonDescriptor;
}

/** Remove an agent's daemon descriptor (best-effort; no-op when absent). */
export function deleteDaemonDescriptor(name: string): void {
	rmSync(getAgentDaemonPath(name), { force: true });
}
