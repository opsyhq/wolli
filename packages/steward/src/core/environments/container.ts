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
import { constants } from "node:fs";
import { basename } from "node:path";
import { APP_NAME, DEFAULT_CONTAINER_IMAGE, ENV_CONTAINER_IMAGE } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { Environment, FileStat } from "./types.ts";

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
	// Every file op runs inside the container via `docker exec`, so it sees the container's own FS
	// (the bind-mounted agent home + the image), never the host outside it.
	readFile: Environment["readFile"];
	writeFile: Environment["writeFile"];
	mkdir: Environment["mkdir"];
	stat: Environment["stat"];
	readdir: Environment["readdir"];
	access: Environment["access"];
	exists: Environment["exists"];
	detectImageMimeType: NonNullable<Environment["detectImageMimeType"]>;
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
	return {
		name: config.name,
		exec: execInContainer(config),
		readFile: readFileInContainer(config),
		writeFile: writeFileInContainer(config),
		mkdir: mkdirInContainer(config),
		stat: statInContainer(config),
		readdir: readdirInContainer(config),
		access: accessInContainer(config),
		exists: existsInContainer(config),
		detectImageMimeType: detectImageMimeTypeInContainer(config),
	};
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
	// Identical-path bind mount: the agent's home stays visible host-side, so the daemon's resource
	// loader picks up self-edits on reload. Nothing else of the host is mounted, so it stays invisible.
	args.push("-v", `${config.cwd}:${config.cwd}`, "-w", config.cwd);
	if (config.user) args.push("--user", config.user);
	args.push(config.image, "sleep", "infinity");
	await docker(args); // pulls the image if it isn't local yet
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

/** `docker exec` into the running container, streaming output — the bash path. */
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

/** The file ops: one `docker exec` each (the capturing sibling of execInContainer), capturing the
 *  whole result rather than streaming. Paths ride in as positional args (`sh -c '… "$1"' sh <path>`)
 *  so the shell never re-splits them. */
function readFileInContainer(config: ContainerConfig): Environment["readFile"] {
	return async (path) => {
		const { exitCode, stdout, stderr } = await captureInContainer(config.name, ["cat", "--", path]);
		if (exitCode !== 0) throw new Error(`read failed: ${stderr.trim() || path}`);
		return stdout;
	};
}

function writeFileInContainer(config: ContainerConfig): Environment["writeFile"] {
	return async (path, content) => {
		const { exitCode, stderr } = await captureInContainer(
			config.name,
			["sh", "-c", 'cat > "$1"', "sh", path],
			content,
		);
		if (exitCode !== 0) throw new Error(`write failed: ${stderr.trim() || path}`);
	};
}

function mkdirInContainer(config: ContainerConfig): Environment["mkdir"] {
	return async (path) => {
		const { exitCode, stderr } = await captureInContainer(config.name, ["mkdir", "-p", "--", path]);
		if (exitCode !== 0) throw new Error(`mkdir failed: ${stderr.trim() || path}`);
	};
}

function statInContainer(config: ContainerConfig): Environment["stat"] {
	return async (path): Promise<FileStat> => {
		const { exitCode, stdout, stderr } = await captureInContainer(config.name, [
			"sh",
			"-c",
			'stat -c "%F|%s" -- "$1"',
			"sh",
			path,
		]);
		if (exitCode !== 0) throw new Error(`stat failed: ${stderr.trim() || path}`);
		const [kind = "", size = "0"] = stdout.toString().trim().split("|");
		return {
			isDirectory: () => kind === "directory",
			isFile: () => kind.startsWith("regular"),
			size: Number.parseInt(size, 10) || 0,
		};
	};
}

function readdirInContainer(config: ContainerConfig): Environment["readdir"] {
	return async (path) => {
		const { exitCode, stdout, stderr } = await captureInContainer(config.name, [
			"sh",
			"-c",
			'ls -1A -- "$1"',
			"sh",
			path,
		]);
		if (exitCode !== 0) throw new Error(`readdir failed: ${stderr.trim() || path}`);
		return stdout
			.toString()
			.split("\n")
			.filter((entry) => entry.length > 0);
	};
}

function accessInContainer(config: ContainerConfig): Environment["access"] {
	return async (path, mode = constants.R_OK) => {
		// Map the fs access mode to test(1) flags; an empty mode (F_OK) checks existence with -e.
		const flags: string[] = [];
		if (mode & constants.R_OK) flags.push("-r");
		if (mode & constants.W_OK) flags.push("-w");
		if (mode & constants.X_OK) flags.push("-x");
		if (flags.length === 0) flags.push("-e");
		const test = flags.map((flag) => `test ${flag} "$1"`).join(" && ");
		const { exitCode } = await captureInContainer(config.name, ["sh", "-c", test, "sh", path]);
		if (exitCode !== 0) throw new Error(`access denied: ${path}`);
	};
}

function existsInContainer(config: ContainerConfig): Environment["exists"] {
	return async (path) =>
		(await captureInContainer(config.name, ["sh", "-c", 'test -e "$1"', "sh", path])).exitCode === 0;
}

function detectImageMimeTypeInContainer(config: ContainerConfig): NonNullable<Environment["detectImageMimeType"]> {
	return async (path) => {
		const { stdout } = await captureInContainer(config.name, [
			"sh",
			"-c",
			'head -c 4100 -- "$1" 2>/dev/null',
			"sh",
			path,
		]);
		return detectSupportedImageMimeType(stdout);
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

interface CaptureResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
}

/** `docker exec` for a file op: binary stdout (cat/head stream raw bytes), exit code returned rather
 *  than thrown so callers map it to fs-style errors, and `input` (when set) piped to stdin. */
function captureInContainer(name: string, argv: string[], input?: string | Uint8Array): Promise<CaptureResult> {
	return new Promise((resolve, reject) => {
		const args = input === undefined ? ["exec", name, ...argv] : ["exec", "-i", name, ...argv];
		const child = spawnProcess("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (data: Buffer) => stdout.push(data));
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ exitCode: code, stdout: Buffer.concat(stdout), stderr }));
		if (child.stdin)
			child.stdin.end(input === undefined ? undefined : typeof input === "string" ? input : Buffer.from(input));
	});
}
