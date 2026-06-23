/**
 * The Environment seam.
 *
 * Every file/shell tool (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`)
 * consumes an `Environment` natively instead of carrying its own pluggable
 * `*Operations` bundle. `HostEnvironment` reproduces today's exact unconfined
 * host behavior; later phases swap the backend (srt / container / micro-VM /
 * cloud) without touching tool code.
 */

import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import { pathExists, resolveToCwd } from "./tools/path-utils.ts";

export interface FileStat {
	isDirectory(): boolean;
	isFile(): boolean;
	size: number;
}

export interface Environment {
	/** Backend identity. "host" in Phase 1; backend name later. */
	readonly id: string;
	/** Working directory the tools are rooted at (== agentDir today). */
	readonly cwd: string;
	/** Resolve a user-supplied path against the environment. Step 2 makes this the jail. */
	resolvePath(p: string): string;
	/** Execute a command and stream its output incrementally via `onData`. */
	exec(
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	): Promise<{ exitCode: number | null }>;
	/** Read file contents as a Buffer. */
	readFile(absolutePath: string): Promise<Buffer>;
	/** Write content to a file. */
	writeFile(absolutePath: string, content: string | Uint8Array): Promise<void>;
	/** Create a directory (recursively). */
	mkdir(dir: string): Promise<void>;
	/** Check access for a path (throws if not accessible). Defaults to R_OK. */
	access(absolutePath: string, mode?: number): Promise<void>;
	/** Whether a path exists. */
	exists(absolutePath: string): Promise<boolean>;
	/** Stat a path. Throws if not found. */
	stat(absolutePath: string): Promise<FileStat>;
	/** Read directory entries. */
	readdir(absolutePath: string): Promise<string[]>;
	/** Detect image MIME type, returning null/undefined for non-images. */
	detectImageMimeType?(absolutePath: string): Promise<string | null | undefined>;
}

/**
 * The host backend: today's defaults, verbatim. `exec` reuses the built-in
 * local shell backend; the filesystem ops are `node:fs/promises` + `pathExists`.
 */
export function createHostEnvironment(cwd: string, options?: { shellPath?: string }): Environment {
	const { exec } = createLocalBashOperations({ shellPath: options?.shellPath });
	return {
		id: "host",
		cwd,
		resolvePath: (p) => resolveToCwd(p, cwd),
		exec,
		readFile: (path) => fsReadFile(path),
		writeFile: (path, content) => fsWriteFile(path, content, typeof content === "string" ? "utf-8" : undefined),
		mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
		access: (path, mode = constants.R_OK) => fsAccess(path, mode),
		exists: pathExists,
		stat: (path) => fsStat(path),
		readdir: (path) => fsReaddir(path),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	};
}
