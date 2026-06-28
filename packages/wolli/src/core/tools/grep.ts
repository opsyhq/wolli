import type { AgentTool } from "@opsyhq/agent";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { Environment } from "../environments/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
// rg has no global match cap, so bound the buffered json against a broad pattern over a large tree.
const MAX_RG_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/** The one ripgrep `--json` event kind we read: a match with its path, line number, and text. */
interface RgEvent {
	type?: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
	};
}

export function createGrepToolDefinition(
	env: Environment,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");

			await ensureTool("rg", true);

			const searchPath = resolveToCwd(searchDir || ".", env.cwd);
			let isDirectory: boolean;
			try {
				isDirectory = (await env.stat(searchPath)).isDirectory();
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			let linesTruncated = false;

			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = path.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) {
						return relative.replace(/\\/g, "/");
					}
				}
				return path.basename(filePath);
			};

			// rg --json prints only the matched line; context lines are read back via env.readFile.
			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = (await env.readFile(filePath)).toString("utf-8");
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
				const relativePath = formatPath(filePath);
				const lines = await getFileLines(filePath);
				if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
				const block: string[] = [];
				const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
				for (let current = start; current <= end; current++) {
					const lineText = lines[current - 1] ?? "";
					const sanitized = lineText.replace(/\r/g, "");
					const isMatchLine = current === lineNumber;
					// Truncate long lines so grep output stays compact.
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
					else block.push(`${relativePath}-${current}- ${truncatedText}`);
				}
				return block;
			};

			// Run rg via env.exec so it only sees the environment's FS (the container for docker). exec
			// merges stdout + stderr, so send rg's stderr to /dev/null — an interleaved diagnostic would
			// otherwise split a json line and drop a match. Errors still surface through the exit code.
			const rgArgs = ["--json", "--line-number", "--color=never", "--hidden"];
			if (ignoreCase) rgArgs.push("--ignore-case");
			if (literal) rgArgs.push("--fixed-strings");
			if (glob) rgArgs.push("--glob", glob);
			rgArgs.push("--", pattern, searchPath);
			const command = `rg ${rgArgs.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")} 2>/dev/null`;

			let raw = "";
			let exitCode: number | null;
			try {
				({ exitCode } = await env.exec(command, env.cwd, {
					onData: (data) => {
						if (raw.length < MAX_RG_OUTPUT_BYTES) raw += data.toString();
					},
					signal,
				}));
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw new Error("Operation aborted");
				throw err;
			}

			// rg has no global match cap, so stop collecting at the limit (and note one extra existed).
			const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
			let matchLimitReached = false;
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let event: RgEvent;
				try {
					event = JSON.parse(line) as RgEvent;
				} catch {
					continue;
				}
				if (event.type !== "match") continue;
				if (matches.length >= effectiveLimit) {
					matchLimitReached = true;
					break;
				}
				const filePath = event.data?.path?.text;
				const lineNumber = event.data?.line_number;
				const lineText = event.data?.lines?.text;
				if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
			}

			if (matches.length === 0) {
				// rg exits 0 with matches, 1 for none; anything else (2 = error, 127 = rg absent) is a real
				// failure whose diagnostics are the merged output.
				if (exitCode !== 0 && exitCode !== 1) {
					throw new Error(raw.trim() || `ripgrep exited with code ${exitCode}`);
				}
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}

			const outputLines: string[] = [];
			for (const match of matches) {
				if (contextValue === 0 && match.lineText !== undefined) {
					const relativePath = formatPath(match.filePath);
					const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
				} else {
					const block = await formatBlock(match.filePath, match.lineNumber);
					outputLines.push(...block);
				}
			}

			const rawOutput = outputLines.join("\n");
			// Apply byte truncation. There is no line limit here because the match limit already capped rows.
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = {};
			// Build actionable notices for truncation and match limits.
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

export function createGrepTool(env: Environment): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(env));
}
