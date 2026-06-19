/**
 * `@opsyhq/cli` dispatch.
 *
 * Agent surfaces are daemon clients: interactive `<name>`, the one-shot `--print`/inline-message
 * path, and `new` (birth chat) attach a `DaemonSession` to the agent's daemon (spawning one if
 * needed) — the CLI never builds a `SessionHost`. `new`/`list`/`delete`/`integrations`/`packages`
 * are local commands (the latter two route their mutating arms to the daemon, the single writer);
 * the hidden `daemon` subcommand runs the engine's `runDaemon` in-process (the long-running server).
 * Only `--help`/`--version` route through the engine `main`.
 */

import { agentExists, APP_NAME, main as engineMain, parseArgs, runDaemon } from "@opsyhq/steward";
import { runDelete } from "./commands/delete.ts";
import { runIntegrations } from "./commands/integrations.ts";
import { runList } from "./commands/list.ts";
import { runNew } from "./commands/new.ts";
import { runPackages } from "./commands/packages.ts";
import { DaemonSession } from "./daemon-session.ts";
import { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { runPrintMode } from "./modes/print-mode.ts";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const command = args.positionals[0];
	const message = args.positionals.slice(1).join(" ").trim();

	// `integrations`/`packages` own their per-subcommand help, so route them (with `args.help`) before
	// the global --help/--version intercept hands off to the engine.
	if (command === "integrations") return runIntegrations(args.positionals.slice(1), args.help);
	if (command === "packages") return runPackages(args.positionals.slice(1), args.help);

	if (args.help || args.version || !command) return engineMain(argv);

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
