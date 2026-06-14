/**
 * Single-shot print mode.
 *
 * Mirrors `@opsyhq/coding-agent`'s modes/print-mode.ts — `runPrintMode(host,
 * options): Promise<number>` where `host` is the harness. Simpler here because
 * `AgentHarness.prompt()` resolves with the final `AssistantMessage` directly,
 * so there are no streaming extensions/output guards to manage.
 */

import type { AgentHarness } from "@opsyhq/agent";
import { collectText, isFailureMessage } from "./message.ts";

export interface RunPrintModeOptions {
	message: string;
}

export async function runPrintMode(host: AgentHarness, options: RunPrintModeOptions): Promise<number> {
	const response = await host.prompt(options.message);
	const text = collectText(response);

	if (isFailureMessage(response)) {
		if (text.trim().length > 0) {
			process.stdout.write(`${text}\n`);
		}
		const reason = response.errorMessage ?? (response.stopReason === "aborted" ? "Aborted." : "Unknown error.");
		process.stderr.write(`${reason}\n`);
		return 1;
	}

	process.stdout.write(`${text}\n`);
	return 0;
}
