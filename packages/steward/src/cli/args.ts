/**
 * CLI argument parsing and help display.
 *
 * Hand-rolled argument parsing (no library).
 * Positionals carry the subcommand / agent name and any inline message.
 */

import type { ThinkingLevel } from "@opsyhq/agent";
import { APP_NAME, CONFIG_DIR_NAME, ENV_HOME } from "../config.ts";

export interface Args {
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** Start a fresh session instead of resuming the latest leaf. */
	new?: boolean;
	/** Force single-shot print mode (default once interactive mode lands). */
	print?: boolean;
	/** Port for the `daemon` subcommand's HTTP/SSE server (0 = OS-assigned ephemeral). */
	port?: number;
	help?: boolean;
	version?: boolean;
	/** Subcommand / agent name followed by any inline message words. */
	positionals: string[];
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		positionals: [],
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--port" && i + 1 < args.length) {
			result.port = Number(args[++i]);
		} else if (arg === "--new") {
			result.new = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg.startsWith("-")) {
			result.diagnostics.push({ type: "warning", message: `Unknown flag "${arg}"` });
		} else {
			result.positionals.push(arg);
		}
	}

	return result;
}

export function printHelp(): void {
	console.log(`${APP_NAME} — persistent, purposeful agents

Usage:
  ${APP_NAME} new <name> [--model provider/id]             Create an agent, then start its birth conversation
  ${APP_NAME} list                                         List agents
  ${APP_NAME} delete <name>                                Delete an agent (type-the-name confirm)
  ${APP_NAME} integrations <add|remove|list|configure> <name> [spec]   Manage an agent's integrations
  ${APP_NAME} packages <install|remove|update|list> <name> [source]    Manage an agent's packages
  ${APP_NAME} <name> [message] [--new] [--print]           Talk to an agent

Options:
  --model <provider/id>   Model to use (e.g. anthropic/claude-opus-4-8)
  --provider <provider>   Provider override
  --thinking <level>      off | minimal | low | medium | high | xhigh
  --new                   Start a fresh session instead of resuming
  --print, -p             Single-shot print mode
  --help, -h              Show this help
  --version, -v           Show version

Agents live under ${ENV_HOME} or ~/${CONFIG_DIR_NAME}/agents/<name>/.`);
}
