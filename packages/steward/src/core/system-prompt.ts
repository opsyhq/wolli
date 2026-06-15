/**
 * System prompt construction.
 *
 * Same file/name/signature as coding-agent's core/system-prompt.ts
 * (`buildSystemPrompt(options): string` + `BuildSystemPromptOptions`). Steward's
 * prompt is built from the agent's identity (name + purpose) plus a frozen
 * snapshot of curated memory (read once at session start — see core/memory.ts).
 */

import type { AgentConfig } from "./agent-config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	// Substrate-forced (wiring): `config` is optional and `cwd` was added so the
	// vendored extension runner can build its `{ cwd }`-shaped placeholder options
	// (`runner.ts:281,342`). Steward always supplies `config` at the real call site.
	config?: AgentConfig;
	/** Working directory (consumed by the vendored runner's default options builder). */
	cwd?: string;
	/** Frozen SOUL.md snapshot. Empty string when absent. */
	soul?: string;
	/** Frozen MEMORY.md snapshot. Empty string when absent. */
	memory?: string;
	/** Frozen USER.md snapshot. Empty string when absent. */
	user?: string;
	/** Skills discovered for this agent, formatted into the frozen prompt (mirrors pi). */
	skills?: Skill[];
}

const BIRTH_INSTRUCTION = [
	"## You are newly created and not yet deployed",
	"",
	"You may not act unattended yet. Your first job is to understand your purpose and your human:",
	"interview them conversationally, one useful question at a time, and record what you learn with the",
	"memory tool (USER = facts about your human; MEMORY = your durable notes). Do not write SOUL.md yet,",
	"and do not start doing the job — first become yourself. Your human's answers are raw material; trust",
	"yourself to distill what you're really for. When the two of you agree you understand your purpose well",
	"enough to begin, call the `deploy` tool with your distilled purpose and final SOUL.md (who you are,",
	"what you're for, how you operate); your human then confirms. Your human may also type /deploy to start",
	"that themselves (optionally with a purpose to use instead of yours).",
].join("\n");

function section(title: string, content: string): string {
	const body = content.trim();
	return `### ${title}\n${body.length > 0 ? body : "(empty)"}`;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { config } = options;
	// The vendored extension runner constructs a `{ cwd }`-only placeholder (no config);
	// steward always passes config at the real call site, so this guard only covers that path.
	if (!config) return "";
	const purpose = config.purpose.trim() || "(no purpose recorded)";

	const parts = [`You are ${config.name}, a persistent, purposeful agent.`, "", "Your purpose:", purpose];

	const soul = options.soul ?? "";
	const memory = options.memory ?? "";
	const user = options.user ?? "";

	parts.push(
		"",
		"## Your curated files (a frozen snapshot — read-only this session; edits are saved immediately but only",
		"become effective next session). Edit MEMORY/USER with the memory tool. Your SOUL.md is authored when you",
		"deploy (via the deploy tool) — don't hand-write it with write/edit while forming.",
		"",
		section("SOUL.md", soul),
		"",
		section("MEMORY.md", memory),
		"",
		section("USER.md", user),
	);

	if (config.deployedAt) {
		parts.push("", "You are deployed: you may now act on your purpose.");
	} else {
		parts.push("", BIRTH_INSTRUCTION);
	}

	// Skills are appended to the frozen prompt (mirrors pi). formatSkillsForPrompt
	// returns "" when there are no model-invocable skills, leaving the prompt unchanged.
	const skillsText = formatSkillsForPrompt(options.skills ?? []);
	if (skillsText) {
		parts.push(skillsText);
	}

	return parts.join("\n");
}
