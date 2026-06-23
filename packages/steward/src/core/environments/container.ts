/**
 * Docker primitive for the container backend (used only by docker.ts).
 *
 * One long-lived container per agent, tracked by labels — the same approach Docker Compose,
 * Dev Containers, and the Hermes agent sandbox use: a marker label carries the identity and a
 * config-hash label (Compose's `config-hash` pattern) triggers a rebuild when image/mount/user
 * change. Labels are the source of truth, so a fresh process finds and reattaches the container
 * with no persisted state. Every call shells out to the docker CLI — no daemon connection.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { APP_NAME, DEFAULT_CONTAINER_IMAGE, ENV_CONTAINER_IMAGE } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { Environment } from "./types.ts";

const CONTAINER_SHELL = "/bin/sh";
const SANDBOX_LABEL = `${APP_NAME}.sandbox`; // marks our containers; value is the container name
const HASH_LABEL = `${APP_NAME}.confighash`; // image/mount/user fingerprint; mismatch => rebuild

export interface ContainerConfig {
	readonly name: string;
	readonly image: string;
	readonly cwd: string;
	readonly user?: string;
	readonly configHash: string;
}

export interface Container {
	readonly name: string;
	exec: Environment["exec"];
}

export async function isContainerSupported(): Promise<boolean> {
	try {
		await docker(["version"]);
		return true;
	} catch {
		return false;
	}
}

/** Deterministic per-agent name. cwd is the agent dir, so basename is the unique agent name. */
function containerName(cwd: string): string {
	return `${APP_NAME}-sbx-${basename(cwd)}`;
}

export function createContainerConfig(cwd: string, options?: { image?: string }): ContainerConfig {
	const image = options?.image ?? process.env[ENV_CONTAINER_IMAGE] ?? DEFAULT_CONTAINER_IMAGE;
	// Linux: run as the host user so bind-mounted files stay host-owned; macOS maps for us.
	const user = process.platform === "linux" ? `${process.getuid?.()}:${process.getgid?.()}` : undefined;
	return {
		name: containerName(cwd),
		image,
		cwd,
		user,
		configHash: createHash("sha256").update(JSON.stringify({ image, cwd, user })).digest("hex").slice(0, 16),
	};
}

/** Bring this agent's container up — reattach it, rebuild it on config drift, or create it. */
export async function startContainer(config: ContainerConfig): Promise<Container> {
	const existing = await findContainer(config.name);
	if (!existing) await createContainer(config);
	else await updateContainer(config, existing);
	return { name: config.name, exec: execInContainer(config) };
}

/** Stop this agent's container on shutdown. It reattaches by label on the next start. */
export async function stopContainer(cwd: string): Promise<void> {
	await docker(["stop", containerName(cwd)]).catch(() => {});
}

/** Look the container up by its identity label; report its run state and stored config hash. */
async function findContainer(name: string): Promise<{ running: boolean; configHash: string } | undefined> {
	const { stdout } = await docker([
		"ps",
		"-a",
		"--filter",
		`label=${SANDBOX_LABEL}=${name}`,
		"--format",
		`{{.State}}\t{{.Label "${HASH_LABEL}"}}`,
	]);
	// The name is unique, so at most one line matches; take the first defensively.
	const [line] = stdout.trim().split("\n");
	if (!line) return undefined;
	const [state, configHash = ""] = line.split("\t");
	return { running: state === "running", configHash };
}

/** Create a fresh container: a detached `sleep infinity` body the execs attach to (no --rm). */
async function createContainer(config: ContainerConfig): Promise<void> {
	const args = ["run", "-d", "--init", "--name", config.name];
	args.push("--label", `${SANDBOX_LABEL}=${config.name}`, "--label", `${HASH_LABEL}=${config.configHash}`);
	args.push("-v", `${config.cwd}:${config.cwd}`, "-w", config.cwd); // identical-path mount: no translation
	if (config.user) args.push("--user", config.user);
	args.push(config.image, "sleep", "infinity");
	await docker(args);
}

/** Reconcile an existing container: rebuild it if the config drifted, resume it if stopped. */
async function updateContainer(
	config: ContainerConfig,
	existing: { running: boolean; configHash: string },
): Promise<void> {
	if (existing.configHash !== config.configHash) {
		await docker(["rm", "-f", config.name]).catch(() => {});
		await createContainer(config);
	} else if (!existing.running) {
		await docker(["start", config.name]);
	}
}

/** `docker exec` into the running container — the only path that crosses into it. */
function execInContainer(config: ContainerConfig): Environment["exec"] {
	return async (command, cwd, { onData, signal, timeout, env }) => {
		if (signal?.aborted) throw new Error("aborted");

		const args = ["exec", "-i", "-w", cwd];
		// Forward the caller's env via -e (as openclaw/hermes do); the -l login shell lets the
		// image profile own PATH.
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
		// Kills the local docker client only; the in-container command can keep running (v1 limit).
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
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode };
		} finally {
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	};
}

/** Run the docker CLI to completion. Throws on non-zero exit; callers that tolerate it catch. */
function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
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
		child.once("close", (code) =>
			code === 0
				? resolve({ stdout, stderr })
				: reject(new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`)),
		);
	});
}
