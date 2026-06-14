/**
 * System prompt construction.
 *
 * Same file/name/signature as coding-agent's core/system-prompt.ts
 * (`buildSystemPrompt(options): string` + `BuildSystemPromptOptions`). Steward's
 * prompt is built from the agent's identity (name + purpose) plus a frozen
 * snapshot of curated memory (read once at session start — see core/memory.ts).
 */

import type { AgentConfig } from "./agent-config.ts";

export interface BuildSystemPromptOptions {
	config: AgentConfig;
	/** Frozen MEMORY.md snapshot. Empty string when absent. */
	memory?: string;
	/** Frozen USER.md snapshot. Empty string when absent. */
	user?: string;
}

function section(title: string, content: string): string {
	const body = content.trim();
	return `### ${title}\n${body.length > 0 ? body : "(empty)"}`;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { config } = options;
	const purpose = config.purpose.trim() || "(no purpose recorded)";

	const parts = [`You are ${config.name}, a persistent, purposeful agent.`, "", "Your purpose:", purpose];

	const memory = options.memory ?? "";
	const user = options.user ?? "";
	if (memory.length > 0 || user.length > 0) {
		parts.push(
			"",
			"## Your memory (read-only this session; edit via the memory tool, effective next session)",
			"",
			section("MEMORY.md", memory),
			"",
			section("USER.md", user),
		);
	}

	return parts.join("\n");
}
