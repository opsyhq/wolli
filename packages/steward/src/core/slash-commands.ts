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
 * Limited to what `handleSubmit` actually dispatches so the menu only ever offers real
 * commands. `deploy` is valid only while forming.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "deploy", description: "Deploy the agent once its purpose and SOUL.md are ready" },
	{ name: "new", description: "Start a new session" },
	{ name: "sessions", description: "Switch to another session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "reload", description: "Reload extensions, skills, and prompts" },
	{ name: "model", description: "Switch the active model" },
	{ name: "thinking", description: "Set the thinking level" },
	{ name: "scoped-models", description: "Configure the session model shortlist" },
	{ name: "login", description: "Log in to a model provider" },
	{ name: "logout", description: "Log out of a model provider" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

/**
 * steward's dashboard (home screen) slash commands — the ones `DashboardView.runCommand`
 * dispatches on submit, surfaced to the editor autocomplete the same way `BUILTIN_SLASH_COMMANDS`
 * are in chat.
 *
 * Kept in lockstep with the `runCommand` if-chain so the menu only ever offers real commands.
 * Lives here (beside `BUILTIN_SLASH_COMMANDS`, not in apps/cli) as shared front-end command
 * metadata a future desktop client can reuse.
 */
export const HOME_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "new", description: "Create a new agent" },
	{ name: "model", description: "Set the default model for agents" },
	{ name: "thinking", description: "Set the default thinking level" },
	{ name: "login", description: "Log in to a model provider" },
	{ name: "logout", description: "Log out of a model provider" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
