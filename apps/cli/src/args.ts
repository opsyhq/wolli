/**
 * CLI argument parsing and help display.
 *
 * Hand-rolled argument parsing (no library).
 * Positionals carry the subcommand / agent name and any inline message.
 */

import { APP_NAME, CONFIG_DIR_NAME, ENV_HOME } from "@opsyhq/wolli";

export interface Args {
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
		} else if (arg === "--port" && i + 1 < args.length) {
			result.port = Number(args[++i]);
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
  ${APP_NAME} new <name>                                   Create an agent, then start its birth conversation
  ${APP_NAME} list                                         List agents
  ${APP_NAME} delete <name>                                Delete an agent (type-the-name confirm)
  ${APP_NAME} restart <name>                               Restart an agent's daemon (picks up code changes)
  ${APP_NAME} <name> plugins <install|remove|list|update|configure> [source]   Manage an agent's plugins
  ${APP_NAME} <name>                                       Open an interactive chat with an agent
  ${APP_NAME} <name> --print <message>                     Single-shot: send a message, print the reply, exit

Options:
  --print, -p             Single-shot print mode
  --help, -h              Show this help
  --version, -v           Show version

Agents live under ${ENV_HOME} or ~/${CONFIG_DIR_NAME}/agents/<name>/.`);
}
