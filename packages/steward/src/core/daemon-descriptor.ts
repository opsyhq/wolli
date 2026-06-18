/**
 * Daemon runtime descriptor.
 *
 * Ephemeral handshake state the daemon writes to the OS temp dir so attach clients can find
 * the running server: the `port` it actually bound, the bearer `token` for `/events` +
 * `/control`, and the owning `pid`. Written at start, removed at shutdown, and gone on reboot
 * regardless. The durable identity (the stable preferred port) lives in agent.json, not here.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ENV_DAEMON_TOKEN, getAgentDaemonPath } from "../config.ts";

export interface DaemonDescriptor {
	/** PID of the daemon process (so a client can detect a stale descriptor). */
	pid: number;
	/** Loopback port the HTTP/SSE server actually bound this run. */
	port: number;
	/** Bearer token authenticating `/events` + `/control`. */
	token: string;
	/** ISO timestamp the daemon started. */
	startedAt: string;
	/** Steward version that wrote the descriptor. */
	version: string;
}

/**
 * The daemon's bearer token: the `STEWARD_DAEMON_TOKEN` env override when set, otherwise a
 * fresh ephemeral one (256 bits, hex-encoded) minted per start.
 */
export function mintDaemonToken(): string {
	return process.env[ENV_DAEMON_TOKEN]?.trim() || randomBytes(32).toString("hex");
}

/** Write an agent's daemon descriptor, creating the runtime dir if needed. */
export function saveDaemonDescriptor(name: string, desc: DaemonDescriptor): void {
	mkdirSync(dirname(getAgentDaemonPath(name)), { recursive: true });
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
