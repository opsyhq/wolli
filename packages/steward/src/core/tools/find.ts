import type { AgentTool } from "@opsyhq/agent";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { Environment } from "../environments/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export function createFindToolDefinition(
	env: Environment,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");

			await ensureTool("fd", true);

			const searchPath = resolveToCwd(searchDir || ".", env.cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			// Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore semantics
			// whether or not the search path is inside a git repository, without leaking sibling-directory
			// rules the way --ignore-file (a global source) would.
			const args: string[] = [
				"--glob",
				"--color=never",
				"--hidden",
				"--no-require-git",
				"--max-results",
				String(effectiveLimit),
			];

			// fd --glob matches against the basename unless --full-path is set; in --full-path mode it
			// matches against the absolute candidate path, so a path-containing pattern like
			// 'src/**/*.spec.ts' needs a leading '**/' to match anything.
			let effectivePattern = pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
					effectivePattern = `**/${pattern}`;
				}
			}
			args.push("--", effectivePattern, searchPath);

			// Run fd via env.exec so it only sees the environment's FS (the container for docker). exec
			// merges stdout + stderr, so send fd's stderr to /dev/null so a diagnostic can't land among
			// the paths. Errors still surface through the exit code.
			const command = `fd ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")} 2>/dev/null`;
			let raw = "";
			let exitCode: number | null;
			try {
				({ exitCode } = await env.exec(command, env.cwd, {
					onData: (data) => {
						raw += data.toString();
					},
					signal,
				}));
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw new Error("Operation aborted");
				throw err;
			}

			const lines = raw
				.split("\n")
				.map((line) => line.replace(/\r$/, "").trim())
				.filter((line) => line.length > 0);
			// fd exits 0 on success whether or not it matched; a non-zero exit with no paths is a real
			// failure (2 = error, 127 = fd absent) whose diagnostics are the merged output.
			if (exitCode !== 0 && lines.length === 0) {
				throw new Error(raw.trim() || `fd exited with code ${exitCode}`);
			}
			if (lines.length === 0) {
				return {
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: undefined,
				};
			}

			const relativized: string[] = [];
			for (const line of lines) {
				const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
				let relativePath = line;
				if (line.startsWith(searchPath)) {
					relativePath = line.slice(searchPath.length + 1);
				} else {
					relativePath = path.relative(searchPath, line);
				}
				if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
				relativized.push(toPosixPath(relativePath));
			}

			const resultLimitReached = relativized.length >= effectiveLimit;
			const rawOutput = relativized.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let resultOutput = truncation.content;
			const details: FindToolDetails = {};
			const notices: string[] = [];
			if (resultLimitReached) {
				notices.push(
					`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.resultLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) {
				resultOutput += `\n\n[${notices.join(". ")}]`;
			}
			return {
				content: [{ type: "text", text: resultOutput }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

export function createFindTool(env: Environment): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(env));
}
