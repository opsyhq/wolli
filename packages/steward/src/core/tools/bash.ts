/**
 * The `bash` tool — run shell commands in the agent's own home directory.
 *
 * Built on the engine's `executeShellWithCapture`, which streams stdout/stderr,
 * caps output (spilling the full log to a temp file when large), and honours the
 * abort signal. The tool's cwd is the agent home (`agents/<name>/`), so SOUL.md,
 * MEMORY.md, USER.md and the `workspace/` subdir all sit right under it — the
 * agent reads and rewrites its own SOUL.md by editing the file directly, and
 * uses the same tool for real work.
 *
 * Per the AgentTool contract we throw only on infrastructure failure; a non-zero
 * exit is a normal observation, returned in the content with an `[exit code N]`
 * note so the model can react.
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
			"subdir. Use it to read and rewrite your own SOUL.md (who you are / what you're for) and to do real work. " +
			"Returns combined stdout/stderr and the exit code. (agent.json is managed for you — commission only via /commission.)",
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
