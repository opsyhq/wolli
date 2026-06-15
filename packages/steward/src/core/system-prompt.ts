/**
 * System prompt construction.
 *
 * The prompt is built from the agent's identity (name + purpose) plus a frozen
 * snapshot of curated memory (read once at session start — see core/memory.ts).
 */

import { APP_NAME, getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { AgentConfig } from "./agent-config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	// `config` is optional and `cwd` exists so the extension runner can build its
	// `{ cwd }`-shaped placeholder options. The real call site always supplies `config`.
	config?: AgentConfig;
	/** Working directory (consumed by the runner's default options builder). */
	cwd?: string;
	/** Frozen SOUL.md snapshot. Empty string when absent. */
	soul?: string;
	/** Frozen MEMORY.md snapshot. Empty string when absent. */
	memory?: string;
	/** Frozen USER.md snapshot. Empty string when absent. */
	user?: string;
	/** Skills discovered for this agent, formatted into the frozen prompt. */
	skills?: Skill[];
	/** Names of the tools active this session, so extensions can tailor guidance. */
	selectedTools?: string[];
	/** Text appended to the end of the system prompt. */
	appendSystemPrompt?: string;
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
	// The extension runner constructs a `{ cwd }`-only placeholder (no config); the real
	// call site always passes config, so this guard only covers that path.
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

	// Docs-guidance block: point the agent at the packaged README/docs/examples so it
	// reads them before authoring extensions/skills/prompt-templates/themes for itself.
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	parts.push(
		"",
		`## ${APP_NAME} documentation (read only when the user asks about ${APP_NAME} itself, its extensions, themes, skills, or prompt templates)`,
		`- Main documentation: ${readmePath}`,
		`- Additional docs: ${docsPath}`,
		`- Examples: ${examplesPath} (extensions, custom tools, SDK)`,
		`- When reading ${APP_NAME} docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory`,
		`- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md)`,
		`- When working on ${APP_NAME} topics, read the docs and examples, and follow .md cross-references before implementing`,
		`- Always read ${APP_NAME} .md files completely and follow links to related docs`,
	);

	// Skills are appended to the frozen prompt. formatSkillsForPrompt
	// returns "" when there are no model-invocable skills, leaving the prompt unchanged.
	const skillsText = formatSkillsForPrompt(options.skills ?? []);
	if (skillsText) {
		parts.push(skillsText);
	}

	if (options.appendSystemPrompt) {
		parts.push("", options.appendSystemPrompt);
	}

	return parts.join("\n");
}
