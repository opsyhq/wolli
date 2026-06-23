/**
 * The Environment seam — leaf types every file/shell tool consumes.
 *
 * Tool/type files type-import from here (not the barrel) so the srt runtime
 * never enters the tool module graph.
 */

export interface FileStat {
	isDirectory(): boolean;
	isFile(): boolean;
	size: number;
}

export interface Environment {
	/** Backend identity. "host" (unconfined) or "local-os" (srt-confined). */
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
