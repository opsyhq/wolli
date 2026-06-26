/**
 * System prompt construction.
 *
 * The prompt is built from the agent's identity (name + purpose) plus a frozen
 * snapshot of curated memory (read once at session start — see core/memory.ts).
 */

import { APP_NAME, getDocsPath, getPluginsDir, getReadmePath } from "../config.ts";
import type { AgentConfig } from "./agent-settings-manager.ts";
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
	"## You are forming — not yet deployed",
	"",
	"You cannot act unattended yet. This session exists to make you real: open the conversation yourself,",
	"then interview your human hard — one sharp question at a time — until you understand what you are for",
	"and who they are. Record as you go with the memory tool: USER = durable facts about your human;",
	"MEMORY = your own durable notes. Their answers are raw material, not gospel — distill what you're",
	"really for, push back, and ask the follow-up. Do not hand-write SOUL.md and do not start doing the",
	"job yet; first become yourself.",
	"",
	"Before you deploy, make sure you can actually do the job — do not set yourself up to fail. Work out",
	"what your purpose needs to reach the outside world (a calendar, email, a chat channel, some API) and",
	"confirm you have it or can get it: a tool you already hold, a ready-made plugin from the bundled",
	"plugins folder (below) that your human installs and onboards, or an integration you author yourself",
	"(read the docs above first). If a required connection is missing, surface it now and get it set up —",
	"never deploy into a purpose you have no way to fulfill.",
	"",
	"SOUL.md (who you are, what you're for, how you operate) is authored at the moment you deploy. The",
	"instant the two of you agree on your purpose and you can actually carry it out, call the `deploy` tool",
	"with your distilled purpose and final SOUL.md; your human confirms. Drive toward that — don't drift.",
	"Your human may also type /deploy to trigger it themselves (optionally with a purpose to use instead",
	"of yours).",
].join("\n");

const EXTENDING_YOURSELF = [
	"## Extending yourself",
	"",
	"You can grow new capabilities, not just edit your files: author extensions (custom tools, slash",
	"commands, events, UI), connect external services and message channels via integrations, and add",
	"skills, prompt templates, and themes — bundle and install them as plugins. Before building from",
	"scratch, check the bundled plugins folder (path below) for a ready-made plugin: if one fits the need",
	"(e.g. Telegram for chat), have your human install and onboard it instead of writing your own. Read",
	"the relevant docs below and follow their cross-references before building anything.",
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
		"## Your curated files",
		"",
		"These are who you are and what you know — a frozen snapshot here (read-only this session; edits save",
		"immediately but become effective next session). Each is modifiable on its own:",
		"- SOUL.md — who you are, what you're for, how you operate. Authored when you deploy; once deployed you",
		"  rewrite it yourself with the bash tool.",
		"- MEMORY.md — your own durable notebook. Edit it with the memory tool.",
		"- USER.md — durable facts about your human. Edit it with the memory tool.",
		"",
		section("SOUL.md", soul),
		"",
		section("MEMORY.md", memory),
		"",
		section("USER.md", user),
	);

	parts.push("", EXTENDING_YOURSELF);

	// Docs-guidance block: point the agent at the packaged README/docs so it
	// reads them before extending or modifying itself.
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const pluginsDir = getPluginsDir();
	parts.push(
		"",
		`## ${APP_NAME} documentation (read when the user asks about ${APP_NAME} itself — its extensions, integrations, skills, prompt templates, themes, plugins, or SDK — or when you extend or modify yourself)`,
		`- Main documentation: ${readmePath}`,
		`- Additional docs: ${docsPath} (resolve docs/... under here, not the current working directory)`,
		`- Topics: extensions (docs/extensions.md), integrations (docs/integrations.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), themes (docs/themes.md), plugins (docs/plugins.md), sdk (docs/sdk.md)`,
		`- Bundled plugins ready to install: ${pluginsDir} (e.g. telegram, scheduler) — prefer installing a fitting one over building from scratch; have your human run \`${APP_NAME} <name> plugins install <path>\` then onboard it`,
		`- When working on ${APP_NAME} topics, read the docs and follow .md cross-references before implementing`,
		`- Always read ${APP_NAME} .md files completely and follow links to related docs`,
	);

	if (!config.deployedAt) {
		parts.push("", BIRTH_INSTRUCTION);
	}

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
