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
	/** Frozen SOUL.md snapshot. Empty string when absent. */
	soul?: string;
	/** Frozen MEMORY.md snapshot. Empty string when absent. */
	memory?: string;
	/** Frozen USER.md snapshot. Empty string when absent. */
	user?: string;
}

const BIRTH_INSTRUCTION = [
	"## You are newly created and not yet commissioned",
	"",
	"You may not act unattended yet. Your first job is to understand your purpose and your human:",
	"interview them conversationally, one useful question at a time, and record what you learn. Write your",
	"SOUL.md (who you are and what you're for) by editing the file with the bash tool, and use the memory",
	"tool for the rest (USER = facts about your human; MEMORY = durable notes). When you understand your",
	"purpose and your human well enough to begin, propose commissioning: summarize who you'll be and ask",
	"them to confirm by typing /commission (or /finalize). Do not start doing the job yet — first become",
	"yourself.",
].join("\n");

function section(title: string, content: string): string {
	const body = content.trim();
	return `### ${title}\n${body.length > 0 ? body : "(empty)"}`;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { config } = options;
	const purpose = config.purpose.trim() || "(no purpose recorded)";

	const parts = [`You are ${config.name}, a persistent, purposeful agent.`, "", "Your purpose:", purpose];

	const soul = options.soul ?? "";
	const memory = options.memory ?? "";
	const user = options.user ?? "";

	parts.push(
		"",
		"## Your curated files (a frozen snapshot — read-only this session; edits are saved immediately but only",
		"become effective next session). Edit SOUL.md with the bash tool; edit MEMORY/USER with the memory tool.",
		"",
		section("SOUL.md", soul),
		"",
		section("MEMORY.md", memory),
		"",
		section("USER.md", user),
	);

	if (config.commissionedAt) {
		parts.push("", "You are commissioned: you may now act on your purpose.");
	} else {
		parts.push("", BIRTH_INSTRUCTION);
	}

	return parts.join("\n");
}
