/**
 * The local-OS confined backend: srt-jailed exec + write-jailed in-process fs.
 *
 * srt confines the `bash` subprocesses it wraps; `write`/`edit`'s own in-process
 * writes never reach srt, so the containment check below jails them. Reads pass
 * through identically to the host — the read plane is deferred to Phase 4.
 */

import { existsSync, lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { canonicalizePath, getCwdRelativePath } from "../../utils/paths.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { createLocalBashOperations } from "../tools/bash.ts";
import { pathExists, resolveToCwd } from "../tools/path-utils.ts";
import { createSandbox, createSandboxConfig } from "./sandbox.ts";
import type { Environment } from "./types.ts";

export async function createLocalOSEnvironment(
	cwd: string,
	options?: { shellPath?: string; allowWrite?: string[] },
): Promise<Environment> {
	const sandbox = await createSandbox(createSandboxConfig(cwd, options));
	const { exec: localExec } = createLocalBashOperations({ shellPath: options?.shellPath });
	const realRoot = canonicalizePath(cwd);

	const ensureInJail = (absolutePath: string): void => {
		// Resolve symlinks on the nearest existing path component (the target may
		// not exist yet) so a symlinked directory can't escape the root, and reject
		// a symlink at the target itself — it can point outside even when its parent
		// is in-jail. getCwdRelativePath returns undefined when the path escapes.
		let anchor = absolutePath;
		while (!existsSync(anchor) && anchor !== dirname(anchor)) anchor = dirname(anchor);
		const escapesRoot = getCwdRelativePath(canonicalizePath(anchor), realRoot) === undefined;
		if (escapesRoot || isSymlink(absolutePath)) {
			throw new Error(`write blocked: ${absolutePath} outside sandbox root ${cwd}`);
		}
	};

	return {
		id: "local-os",
		cwd,
		resolvePath: (p) => resolveToCwd(p, cwd),
		exec: async (command, execCwd, execOptions) => {
			// Wrap for the same shell localExec spawns, so the inner sandboxed command
			// runs under the user's shell rather than srt's default.
			const { shell } = getShellConfig(options?.shellPath);
			const wrapped = await sandbox.wrap(command, shell);
			try {
				return await localExec(wrapped, execCwd, execOptions);
			} finally {
				sandbox.cleanupAfterCommand();
			}
		},
		readFile: (path) => fs.readFile(path),
		writeFile: async (path, content) => {
			ensureInJail(path);
			await fs.writeFile(path, content, typeof content === "string" ? "utf-8" : undefined);
		},
		mkdir: async (dir) => {
			ensureInJail(dir);
			await fs.mkdir(dir, { recursive: true });
		},
		access: (path, mode = fs.constants.R_OK) => fs.access(path, mode),
		exists: pathExists,
		stat: (path) => fs.stat(path),
		readdir: (path) => fs.readdir(path),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	};
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
