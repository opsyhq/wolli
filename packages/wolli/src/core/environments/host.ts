/** The unconfined host backend: today's defaults, verbatim. */

import * as fs from "node:fs/promises";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { createLocalBashOperations } from "../tools/bash.ts";
import { pathExists, resolveToCwd } from "../tools/path-utils.ts";
import type { Environment } from "./types.ts";

export function createHostEnvironment(cwd: string, options?: { shellPath?: string }): Environment {
	const { exec } = createLocalBashOperations({ shellPath: options?.shellPath });
	return {
		id: "host",
		cwd,
		resolvePath: (p) => resolveToCwd(p, cwd),
		exec,
		readFile: (path) => fs.readFile(path),
		writeFile: (path, content) => fs.writeFile(path, content, typeof content === "string" ? "utf-8" : undefined),
		mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
		access: (path, mode = fs.constants.R_OK) => fs.access(path, mode),
		exists: pathExists,
		stat: (path) => fs.stat(path),
		readdir: (path) => fs.readdir(path),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	};
}
