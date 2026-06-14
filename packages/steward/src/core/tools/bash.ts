/**
 * The `bash` tool.
 *
 * This is the one file tool steward does NOT copy verbatim from coding-agent.
 * pi's bash.ts manages detached process groups, kill-tree-on-abort, shell
 * discovery, and output spooling via `cross-spawn` + `getBinDir` — capabilities
 * the engine already ships as `executeShellWithCapture` (streaming, output cap
 * with temp-file spill, abort-aware). Re-vendoring pi's OS-specific process
 * machinery would duplicate the engine, so we build on the engine primitive
 * instead. Behavior (combined stdout/stderr, exit code, truncation note) matches.
 *
 * The cwd is the agent's home dir, where SOUL/MEMORY/USER.md and the workspace/
 * subdir live. Non-zero exits are returned as normal observations; only
 * infrastructure failures throw.
 */

import { type AgentTool, type ExecutionEnv, executeShellWithCapture } from "@opsyhq/agent";
import { type Static, Type } from "typebox";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to run." }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default)." })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export function createBashTool(env: ExecutionEnv, cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Run a bash command in your home directory, which holds your SOUL.md, MEMORY.md, USER.md and a workspace/ " +
			"subdir. Use it for real work and shell tasks. Returns combined stdout/stderr and the exit code. " +
			"(agent.json is managed for you — commission only via /commission.)",
		parameters: bashSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const result = await executeShellWithCapture(env, params.command, {
				cwd,
				timeout: params.timeout,
				abortSignal: signal,
			});
			if (!result.ok) {
				// Infrastructure failure (spawn error, capture error): surface as a tool error.
				throw new Error(result.error.message);
			}

			const { output, exitCode, cancelled, truncated, fullOutputPath } = result.value;
			const parts: string[] = [];
			if (output.trim().length > 0) parts.push(output.trimEnd());
			if (cancelled) parts.push("[aborted]");
			else if (exitCode !== undefined && exitCode !== 0) parts.push(`[exit code ${exitCode}]`);
			if (truncated && fullOutputPath) parts.push(`[output truncated — full output: ${fullOutputPath}]`);
			const text = parts.join("\n").trim() || "(no output)";

			return {
				content: [{ type: "text", text }],
				details: { exitCode, cancelled, truncated, fullOutputPath },
			};
		},
	};
}
