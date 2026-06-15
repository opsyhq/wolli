import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

/**
 * steward's built-in interactive slash commands — the ones `InteractiveMode.handleSubmit`
 * intercepts before a prompt reaches the model, surfaced to the editor autocomplete by
 * `createBaseAutocompleteProvider`.
 *
 * Divergence: an earlier port copied pi's full 22-command list verbatim, but steward
 * implements none of those extras (settings/model/export/fork/…). Listing them would offer
 * the human commands that do nothing but get echoed to the model as text. Trimmed to what
 * `handleSubmit` actually dispatches so the menu only ever offers real commands. `deploy`
 * is steward-specific (pi has no deploy); it is valid only while forming.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "deploy", description: "Deploy the agent once its purpose and SOUL.md are ready" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
