/**
 * `@opsyhq/cli` dispatch.
 *
 * Agent surfaces are daemon clients: interactive `<name>`, the one-shot `--print`/inline-message
 * path, and `new` (birth chat) attach a `DaemonSession` to the agent's daemon (spawning one if
 * needed) — the CLI never builds a `SessionHost`. `new`/`list`/`delete` are local commands; the
 * hidden `daemon` subcommand runs the engine's `runDaemon` in-process (the long-running
 * server). `integrations`/`packages` (+ help/version) route through the engine `main`.
 */

import { agentExists, APP_NAME, main as engineMain, parseArgs, runDaemon } from "@opsyhq/steward";
import { runDelete } from "./commands/delete.ts";
import { runList } from "./commands/list.ts";
import { runNew } from "./commands/new.ts";
import { DaemonSession } from "./daemon-session.ts";
import { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { runPrintMode } from "./modes/print-mode.ts";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const command = args.positionals[0];
	const message = args.positionals.slice(1).join(" ").trim();

	// Verbs the engine still owns; it re-parses argv and emits their diagnostics/usage.
	const engineOwned = command === "integrations" || command === "packages";
	if (args.help || args.version || !command || engineOwned) return engineMain(argv);

	for (const diagnostic of args.diagnostics) process.stderr.write(`${diagnostic.message}\n`);

	if (command === "new") return runNew(args.positionals.slice(1), args.model);
	if (command === "list") return runList();
	if (command === "delete") return runDelete(args.positionals.slice(1));

	// Hidden `daemon <name>`: the long-running HTTP/SSE server. Both the OS service unit and
	// `DaemonSession.open`'s detached spawn invoke this same subcommand.
	if (command === "daemon") {
		const name = args.positionals[1];
		if (!name) {
			process.stderr.write(`Usage: ${APP_NAME} daemon <name> [--port <n>]\n`);
			return 1;
		}
		return runDaemon(name, {
			port: args.port,
			fresh: args.new,
			provider: args.provider,
			model: args.model,
			thinking: args.thinking,
		});
	}

	if (!agentExists(command)) {
		process.stderr.write(`Unknown agent "${command}". Create it with: ${APP_NAME} new ${command}\n`);
		return 1;
	}
	if (args.print || message) {
		if (!message) {
			process.stderr.write(`Print mode needs a message: ${APP_NAME} ${command} --print "<message>"\n`);
			return 1;
		}
		return runPrintMode(await DaemonSession.open(command), message);
	}
	await new InteractiveMode(await DaemonSession.open(command)).run();
	return 0;
}
