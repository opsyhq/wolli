/**
 * Container backend: docker-confined bash + write-jailed host-side fs. local-os with one
 * method swapped — the agent dir is bind-mounted at the identical path, so the file tools
 * stay host-side on the mount and only bash crosses into the container.
 */

import { existsSync, lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { canonicalizePath, getCwdRelativePath } from "../../utils/paths.ts";
import { pathExists, resolveToCwd } from "../tools/path-utils.ts";
import { createContainerConfig, startContainer } from "./container.ts";
import type { Environment } from "./types.ts";

export async function createDockerEnvironment(
	cwd: string,
	options?: { shellPath?: string; allowWrite?: string[]; image?: string },
): Promise<Environment> {
	const container = await startContainer(createContainerConfig(cwd, options));
	const realRoot = canonicalizePath(cwd);

	// docker confines bash, but the file tools write host-side via node:fs and bypass it, so the
	// same write-jail as local-os gates them here. Resolve symlinks on the nearest existing
	// component (the target may not exist yet) and reject a symlink at the target itself.
	const ensureInJail = (absolutePath: string): void => {
		let anchor = absolutePath;
		while (!existsSync(anchor) && anchor !== dirname(anchor)) anchor = dirname(anchor);
		const escapes = getCwdRelativePath(canonicalizePath(anchor), realRoot) === undefined;
		if (escapes || isSymlink(absolutePath))
			throw new Error(`write blocked: ${absolutePath} outside sandbox root ${cwd}`);
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

// lstatSync throws when the target doesn't exist yet (the common new-file write) — not a symlink.
function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
