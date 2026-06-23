/**
 * The container backend: docker-confined exec + write-jailed in-process fs.
 *
 * This is `local-os` with one method swapped. The agent dir is bind-mounted into the
 * container at the identical path, so `read/write/edit/ls/grep/find` stay host-side
 * (`node:fs` on the mount, write-jailed) and never enter the container — only `bash`
 * crosses in via `docker exec`, where host path == container path means no translation.
 * Workspace persistence is free: the bytes live in the host agent dir; the container is
 * disposable.
 */

import { existsSync, lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { canonicalizePath, getCwdRelativePath } from "../../utils/paths.ts";
import { pathExists, resolveToCwd } from "../tools/path-utils.ts";
import { createContainer, createContainerConfig } from "./container.ts";
import type { Environment } from "./types.ts";

export async function createDockerEnvironment(
	cwd: string,
	// `shellPath`/`allowWrite` mirror local-os so the selector hands every backend one opts
	// shape; docker ignores them (the container owns its shell, the jail is cwd-only) and
	// reads only `image`.
	options?: { shellPath?: string; allowWrite?: string[]; image?: string },
): Promise<Environment> {
	const container = await createContainer(createContainerConfig(cwd, options));
	const realRoot = canonicalizePath(cwd);

	// Duplicated from local-os.ts (the plan defers extraction): docker confines `bash`,
	// but the file tools write host-side via node:fs and bypass the container entirely —
	// without this jail the docker backend would be *less* confined than local-os.
	const ensureInJail = (absolutePath: string): void => {
		// Resolve symlinks on the nearest existing path component (the target may not exist
		// yet) so a symlinked directory can't escape the root, and reject a symlink at the
		// target itself — it can point outside even when its parent is in-jail.
		let anchor = absolutePath;
		while (!existsSync(anchor) && anchor !== dirname(anchor)) anchor = dirname(anchor);
		const escapesRoot = getCwdRelativePath(canonicalizePath(anchor), realRoot) === undefined;
		if (escapesRoot || isSymlink(absolutePath)) {
			throw new Error(`write blocked: ${absolutePath} outside sandbox root ${cwd}`);
		}
	};

	return {
		id: "docker",
		cwd,
		resolvePath: (p) => resolveToCwd(p, cwd),
		exec: container.exec,
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
