/**
 * `@opsyhq/cli` dispatch.
 *
 * Agent surfaces are daemon clients: interactive `<name>`, `new` (birth chat), and the one-shot
 * `--print`/inline-message path attach a `DaemonSession` to the agent's daemon (spawning one if
 * needed) — the CLI never builds a `SessionHost`. `list`/`delete`/`integrations`/`packages` and the
 * hidden `daemon` runner route through the engine `main`.
 */

import { agentExists, APP_NAME, createAgent, main as engineMain, parseArgs } from "@opsyhq/steward";
import { DaemonSession } from "./daemon-session.ts";
import { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { runPrintMode } from "./modes/print-mode.ts";

// A newly born agent opens the chat itself, asking its human what it is for.
const BIRTH_OPENER = "What is my purpose?";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const command = args.positionals[0];
	const message = args.positionals.slice(1).join(" ").trim();

	// Verbs the engine still owns; it re-parses argv and emits their diagnostics/usage.
	const engineOwned =
		command === "list" ||
		command === "delete" ||
		command === "integrations" ||
		command === "packages" ||
		command === "daemon";
	if (args.help || args.version || !command || engineOwned) return engineMain(argv);

	for (const diagnostic of args.diagnostics) process.stderr.write(`${diagnostic.message}\n`);

	if (command === "new") {
		const name = args.positionals[1];
		if (!name || args.positionals.length > 2) {
			process.stderr.write(`Usage: ${APP_NAME} new <name>\n`);
			return 1;
		}
		if (agentExists(name)) {
			process.stderr.write(`Agent "${name}" already exists.\n`);
			return 1;
		}
		const config = createAgent({ name, model: args.model });
		process.stdout.write(`Created agent "${config.name}".\n`);
		const session = await DaemonSession.open(name);
		await new InteractiveMode(session, { initialAssistantMessage: BIRTH_OPENER }).run();
		return 0;
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
