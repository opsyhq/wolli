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
import chalk from "chalk";
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
	// The file-op surface: every read/write the agent's tools make runs inside the container via
	// `docker exec`, so it sees the container's own FS (the bind-mounted agent home + the image),
	// never the host outside it.
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
	// grep/find run rg/fd inside the container; ensure the slim default image has them. Runs on every
	// start (not just create) and is idempotent, so it self-heals a container whose earlier
	// provisioning failed (e.g. offline). A custom image is the user's responsibility (documented).
	if (config.image === DEFAULT_CONTAINER_IMAGE) await provisionSearchTools(config.name);
	return { name: config.name, exec: execInContainer(config), ...createContainerFileOps(config.name) };
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
	// Identical-path bind mount (no translation): the agent's home is its own dir, so its writes stay
	// visible host-side for the daemon's resource loader to pick up on reload. The rest of the host FS
	// is NOT mounted, so it stays invisible to the container.
	args.push("-v", `${config.cwd}:${config.cwd}`, "-w", config.cwd);
	if (config.user) args.push("--user", config.user);
	args.push(config.image, "sleep", "infinity");
	await docker(args);
}

/**
 * Install ripgrep + fd into the default image (it carries neither). Skips immediately when both are
 * already present, so it is cheap to call on every start and self-heals a container provisioned
 * while offline. Runs as root via `--user 0:0` since the agent user may be unprivileged; fd ships as
 * `fdfind` on Debian, so symlink it to `fd`. Best-effort: on failure (offline, or a swapped-in
 * non-apt image) grep/find surface a clear "command not found" rather than reading the host.
 */
async function provisionSearchTools(name: string): Promise<void> {
	const script =
		"command -v rg >/dev/null 2>&1 && command -v fd >/dev/null 2>&1 && exit 0; " +
		"apt-get update -qq && apt-get install -y -qq --no-install-recommends ripgrep fd-find && " +
		'ln -sf "$(command -v fdfind)" /usr/local/bin/fd';
	try {
		await docker(["exec", "--user", "0:0", name, "sh", "-c", script]);
	} catch (error) {
		console.error(
			chalk.yellow(
				`Warning: could not install rg/fd in the sandbox container; grep/find may be unavailable: ${error}`,
			),
		);
	}
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

interface FileExecResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
}

/**
 * One `docker exec` for a file operation. User paths ride in as positional args (`sh -c '…' sh
 * "$1"`) to dodge shell quoting; stdout is kept binary (cat/head stream raw bytes); the exit code is
 * returned, not thrown, so callers map it to fs-style errors. `input`, when present, is piped to the
 * command's stdin (the `-i` write path).
 */
function dockerFileExec(name: string, argv: string[], input?: string | Uint8Array): Promise<FileExecResult> {
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

/** The `Environment` file methods, each backed by one `docker exec` into the running container. */
function createContainerFileOps(name: string): Omit<Container, "name" | "exec"> {
	const run = (argv: string[], input?: string | Uint8Array) => dockerFileExec(name, argv, input);
	return {
		readFile: async (path) => {
			const { exitCode, stdout, stderr } = await run(["cat", "--", path]);
			if (exitCode !== 0) throw new Error(`read failed: ${stderr.trim() || path}`);
			return stdout;
		},
		writeFile: async (path, content) => {
			const { exitCode, stderr } = await run(["sh", "-c", 'cat > "$1"', "sh", path], content);
			if (exitCode !== 0) throw new Error(`write failed: ${stderr.trim() || path}`);
		},
		mkdir: async (path) => {
			const { exitCode, stderr } = await run(["mkdir", "-p", "--", path]);
			if (exitCode !== 0) throw new Error(`mkdir failed: ${stderr.trim() || path}`);
		},
		stat: async (path): Promise<FileStat> => {
			const { exitCode, stdout, stderr } = await run(["sh", "-c", 'stat -c "%F|%s" -- "$1"', "sh", path]);
			if (exitCode !== 0) throw new Error(`stat failed: ${stderr.trim() || path}`);
			const [kind = "", size = "0"] = stdout.toString().trim().split("|");
			return {
				isDirectory: () => kind === "directory",
				isFile: () => kind.startsWith("regular"),
				size: Number.parseInt(size, 10) || 0,
			};
		},
		readdir: async (path) => {
			const { exitCode, stdout, stderr } = await run(["sh", "-c", 'ls -1A -- "$1"', "sh", path]);
			if (exitCode !== 0) throw new Error(`readdir failed: ${stderr.trim() || path}`);
			return stdout
				.toString()
				.split("\n")
				.filter((entry) => entry.length > 0);
		},
		access: async (path, mode = constants.R_OK) => {
			// Map the fs access mode to test(1) flags; an empty mode (F_OK) checks existence with -e.
			const flags: string[] = [];
			if (mode & constants.R_OK) flags.push("-r");
			if (mode & constants.W_OK) flags.push("-w");
			if (mode & constants.X_OK) flags.push("-x");
			if (flags.length === 0) flags.push("-e");
			const test = flags.map((flag) => `test ${flag} "$1"`).join(" && ");
			const { exitCode } = await run(["sh", "-c", test, "sh", path]);
			if (exitCode !== 0) throw new Error(`access denied: ${path}`);
		},
		exists: async (path) => (await run(["sh", "-c", 'test -e "$1"', "sh", path])).exitCode === 0,
		detectImageMimeType: async (path) => {
			const { stdout } = await run(["sh", "-c", 'head -c 4100 -- "$1" 2>/dev/null', "sh", path]);
			return detectSupportedImageMimeType(stdout);
		},
	};
}
