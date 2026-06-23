/**
 * The docker isolation primitive, consumed only by `docker.ts`. Mirrors
 * `sandbox.ts`: it hides the docker CLI behind a thin function surface and
 * memoizes one long-lived container per agent so `bash` calls (and `/reload`)
 * reuse it instead of paying `docker run` each time.
 *
 * Like openclaw/hermes, every command spawns the `docker` CLI — there is no
 * dockerode, no persistent daemon connection. The container is named
 * deterministically from the agent dir, so a daemon restart reattaches to the
 * same writable layer with no stored state.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { APP_NAME, DEFAULT_CONTAINER_IMAGE, ENV_CONTAINER_IMAGE } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { Environment } from "./types.ts";

/** Login shell run inside the container. `-l` lets the image's profile own PATH. */
const CONTAINER_SHELL = "/bin/sh";
/** Label stamped at create so a config drift (image/mount/user) forces a recreate. */
const CONFIG_HASH_LABEL = `${APP_NAME}.confighash`;

export interface ContainerConfig {
	/** Deterministic name `${APP_NAME}-sbx-${basename(cwd)}` — the reattach key. */
	readonly name: string;
	/** Image to run. */
	readonly image: string;
	/** Host dir bind-mounted at the identical path; also the container working dir. */
	readonly cwd: string;
	/** `uid:gid` to run as (linux only; undefined where the platform maps automatically). */
	readonly user?: string;
}

export interface Container {
	readonly name: string;
	exec: Environment["exec"];
}

/** Whether docker can confine on this host — `docker version` reaches a live daemon. */
export async function isContainerSupported(): Promise<boolean> {
	try {
		const { exitCode } = await runDocker(["version"]);
		return exitCode === 0;
	} catch {
		return false;
	}
}

export function createContainerConfig(cwd: string, options?: { image?: string }): ContainerConfig {
	return {
		// cwd is the per-agent dir (~/.steward/agents/<name>), so basename is the unique agent
		// name — no cross-agent name collisions despite using basename rather than the full path.
		name: `${APP_NAME}-sbx-${basename(cwd)}`,
		image: options?.image ?? process.env[ENV_CONTAINER_IMAGE] ?? DEFAULT_CONTAINER_IMAGE,
		cwd,
		// Linux exec-created files inherit the host user so the bind-mounted agent dir stays
		// host-owned; macOS Docker Desktop maps ownership for us, so leave the image default.
		user: process.platform === "linux" ? `${process.getuid?.()}:${process.getgid?.()}` : undefined,
	};
}

// One container per name, memoized like the srt singleton: repeated createContainer
// (every bash call, every /reload) reuse it instead of recreating. Cleared on ensure
// failure (retry next call) and on reset.
const active = new Map<string, Promise<Container>>();

export function createContainer(config: ContainerConfig): Promise<Container> {
	let pending = active.get(config.name);
	if (!pending) {
		pending = ensureContainer(config)
			.then(() => ({ name: config.name, exec: createContainerExec(config) }))
			.catch((err: unknown) => {
				active.delete(config.name);
				throw err;
			});
		active.set(config.name, pending);
	}
	return pending;
}

/** Best-effort `docker stop` of every memoized container + clear the memo. Safe when none ran. */
export async function resetContainers(): Promise<void> {
	const names = [...active.keys()];
	active.clear();
	await Promise.all(
		names.map((name) =>
			// Stop, not remove: the writable layer + deterministic name let the next run reattach.
			runDocker(["stop", name]).catch(() => {
				// Best-effort: stop failures must not block daemon shutdown.
			}),
		),
	);
}

/**
 * Ensure the named container is up to date and running: start it if stopped, recreate it
 * if its config-hash label drifted (image/mount/user changed), create it if absent.
 */
async function ensureContainer(config: ContainerConfig): Promise<void> {
	const hash = computeConfigHash(config);
	const existing = await inspectContainer(config.name);
	if (existing) {
		if (existing.configHash === hash) {
			if (!existing.running) await dockerOk(["start", config.name]);
			return;
		}
		await dockerOk(["rm", "-f", config.name]);
	}

	const args = [
		"run",
		"-d", // detached: a long-lived `sleep infinity` body the bash execs attach to
		"--init", // tini reaps zombies (the in-container orphan-on-abort limit is documented)
		"--name",
		config.name,
		"--label",
		`${CONFIG_HASH_LABEL}=${hash}`,
		"-v",
		`${config.cwd}:${config.cwd}`, // identical-path mount ⇒ no path translation for bash
		"-w",
		config.cwd,
	];
	if (config.user) args.push("--user", config.user);
	args.push(config.image, "sleep", "infinity");
	await dockerOk(args);
}

/** Hash the fields that, when changed, require a fresh container. */
function computeConfigHash(config: ContainerConfig): string {
	return createHash("sha256")
		.update(JSON.stringify({ image: config.image, cwd: config.cwd, user: config.user }))
		.digest("hex")
		.slice(0, 16);
}

/** Read a container's run state + config-hash label, or undefined when it does not exist. */
async function inspectContainer(name: string): Promise<{ running: boolean; configHash: string } | undefined> {
	const format = `{{.State.Running}}\t{{index .Config.Labels "${CONFIG_HASH_LABEL}"}}`;
	const { exitCode, stdout } = await runDocker(["inspect", "--format", format, name]);
	if (exitCode !== 0) return undefined;
	const [running, configHash = ""] = stdout.trim().split("\t");
	return { running: running === "true", configHash };
}

/**
 * The container's `exec`: spawn `docker exec -i -w <cwd> [-e K=V…] <name> /bin/sh -lc <command>`
 * through the same child-process + tracking utilities `bash.ts` uses, streaming both pipes to
 * `onData`. Abort/timeout kills the local docker client (matching openclaw/hermes); the
 * in-container command itself keeps running — a documented v1 limit (no in-container reaper).
 */
function createContainerExec(config: ContainerConfig): Environment["exec"] {
	return async (command, cwd, { onData, signal, timeout, env }) => {
		if (signal?.aborted) {
			throw new Error("aborted");
		}

		const args = ["exec", "-i", "-w", cwd];
		// Forward the caller's env via -e, matching openclaw/hermes. The `-l` login shell
		// re-sources the image's profile, so the container's own PATH wins over a forwarded
		// host PATH (other host vars still pass through — same as prior art).
		for (const [key, value] of Object.entries(env ?? {})) {
			if (value !== undefined) args.push("-e", `${key}=${value}`);
		}
		args.push(config.name, CONTAINER_SHELL, "-lc", command);

		const child = spawnProcess("docker", args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid) trackDetachedChildPid(child.pid);
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const onAbort = () => {
			if (child.pid) killProcessTree(child.pid);
		};

		try {
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeout * 1000);
			}
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			const exitCode = await waitForChildProcess(child);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			if (timedOut) {
				throw new Error(`timeout:${timeout}`);
			}
			return { exitCode };
		} finally {
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	};
}

/** Run a docker CLI command to completion, collecting its output. Rejects only on spawn failure. */
function runDocker(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawnProcess("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ exitCode: code, stdout, stderr }));
	});
}

/** Run a docker CLI command and throw if it exits non-zero. */
async function dockerOk(args: string[]): Promise<void> {
	const { exitCode, stderr } = await runDocker(args);
	if (exitCode !== 0) {
		throw new Error(`docker ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
}
