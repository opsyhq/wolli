/**
 * `@opsyhq/cli` dispatch.
 *
 * The interactive TUI is a daemon client now: `<name>` (and `new`) resolve the agent's daemon
 * (spawning one if needed) and attach a `DaemonSession`, then run `InteractiveMode` against it —
 * the CLI never builds a `SessionHost`. The non-interactive verbs (`list`/`delete`/`integrations`/
 * `packages`, the hidden `daemon` runner, and the one-shot `--print` path) still route through the
 * engine `main` until their own slices move them client-side.
 */

import { agentExists, APP_NAME, type Args, createAgent, main as engineMain, parseArgs } from "@opsyhq/steward";
import { DaemonSession } from "./daemon-session.ts";
import { InteractiveMode } from "./interactive/interactive-mode.ts";

/**
 * The first thing a newly created agent "says" — seeded as an assistant message into the birth
 * session so the agent opens by asking its human what it is for.
 */
const BIRTH_OPENER = "What is my purpose?";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const command = args.positionals[0];
	const message = args.positionals.slice(1).join(" ").trim();

	// Verbs the engine still owns (no interactive TUI), plus global help/version and the one-shot
	// `--print`/inline path (Slice 2 moves it client-side). The engine `main` re-parses argv and
	// handles these — including its own diagnostics/usage output.
	const engineOwned =
		command === "list" ||
		command === "delete" ||
		command === "integrations" ||
		command === "packages" ||
		command === "daemon";
	if (args.help || args.version || !command || engineOwned) return engineMain(argv);
	if (command !== "new" && (args.print || message)) return engineMain(argv);

	// apps/cli owns `new` + interactive `<name>` from here; surface arg diagnostics like the engine does.
	for (const diagnostic of args.diagnostics) process.stderr.write(`${diagnostic.message}\n`);
	if (command === "new") return runNew(args);
	return runInteractive(command);
}

/** Attach to (or spawn) the agent's daemon and run the interactive TUI against it. */
async function runInteractive(name: string): Promise<number> {
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}
	const session = await DaemonSession.open(name);
	await new InteractiveMode(session).run();
	return 0;
}

/**
 * `new <name>` — create the agent, then run the birth chat as a daemon client. The opener is seeded
 * server-side via the `seed_assistant_message` verb. (Slice 3 / Item 6 adds the stable-port
 * allocation + service lifecycle; for now `open()` spawns an ephemeral birth daemon.)
 */
async function runNew(args: Args): Promise<number> {
	const name = args.positionals[1];
	// Birth is chat-only: a name is all `new` takes (the agent distills its own purpose in-chat).
	if (!name || args.positionals.length > 2) {
		process.stderr.write(`Usage: ${APP_NAME} new <name>\n`);
		return 1;
	}
	if (agentExists(name)) {
		process.stderr.write(`Agent "${name}" already exists.\n`);
		return 1;
	}

	// createAgent throws on an invalid name; cli.ts's top-level catch prints it and exits 1.
	const config = createAgent({ name, model: args.model });
	process.stdout.write(`Created agent "${config.name}".\n`);

	const session = await DaemonSession.open(name);
	await new InteractiveMode(session, { initialAssistantMessage: BIRTH_OPENER }).run();
	return 0;
}
