/**
 * `@opsyhq/cli` dispatch.
 *
 * Agent surfaces are daemon clients: interactive `<name>`, the one-shot `--print` path (single-shot,
 * requires an inline message), and `new` (birth chat) connect to the agent's daemon (spawning one if needed) and drive a
 * `SessionHandle` — the CLI never builds a `SessionHost`. `new`/`list`/`delete` are local commands; the
 * agent-scoped `<name> plugins ...` subcommand routes its mutating arms to the daemon (the single
 * writer); the hidden `daemon` subcommand runs the engine's `runDaemon` in-process (the
 * long-running server). `--help`/`--version` and the no-command usage are handled locally here.
 *
 * `plugins` is a reserved second positional: an inline chat message whose first word is `plugins`
 * is no longer deliverable (messages not starting with `plugins` are unaffected).
 */

import { APP_NAME, AuthStorage, ModelRegistry, runDaemon, Wolli, VERSION } from "@opsyhq/wolli";
import { parseArgs, printHelp } from "./args.ts";
import { runDelete } from "./commands/delete.ts";
import { runList } from "./commands/list.ts";
import { runNew } from "./commands/new.ts";
import { runPlugins } from "./commands/plugins.ts";
import { runRestart } from "./commands/restart.ts";
import { App, type Route } from "./modes/interactive/app.ts";
import { runPrintMode } from "./modes/print-mode.ts";

export async function main(argv: string[]): Promise<number> {
	const wolli = new Wolli();
	const args = parseArgs(argv);
	const command = args.positionals[0];
	const sub = args.positionals[1];
	const message = args.positionals.slice(1).join(" ").trim();

	// The agent-scoped `<agent> plugins <verb> ...` subcommand owns its per-verb help, so route it
	// (with `args.help`) before the global --help/--version intercept hands off to the engine.
	if (sub === "plugins") return runPlugins(command, args.positionals.slice(2), args.help);

	if (args.help) {
		printHelp();
		return 0;
	}
	if (args.version) {
		console.log(`${APP_NAME} ${VERSION}`);
		return 0;
	}

	for (const diagnostic of args.diagnostics) process.stderr.write(`${diagnostic.message}\n`);

	// Bare `wolli`: a fresh machine with no configured provider gets the guided first-run; otherwise
	// the dashboard. `ModelRegistry.create` reflects env keys immediately (env keys count via hasAuth),
	// so a working env key still routes to the dashboard.
	if (!command) {
		const app = new App(wolli);
		const auth = AuthStorage.create();
		const registry = ModelRegistry.create(auth);
		const hasProvider = registry.getAvailable().length > 0;
		const route: Route = hasProvider || wolli.list().length > 0 ? { to: "dashboard" } : { to: "onboarding" };
		await app.start(route);
		return 0;
	}

	if (command === "new") return runNew(args.positionals.slice(1));
	if (command === "list") return runList();
	if (command === "delete") return runDelete(args.positionals.slice(1));
	if (command === "restart") return runRestart(args.positionals.slice(1));

	// Hidden `daemon <name>`: the long-running HTTP/SSE server. Both the OS service unit and
	// `Agent.open`'s detached spawn invoke this same subcommand.
	if (command === "daemon") {
		const name = args.positionals[1];
		if (!name) {
			process.stderr.write(`Usage: ${APP_NAME} daemon <name> [--port <n>]\n`);
			return 1;
		}
		return runDaemon(name, { port: args.port });
	}

	const agent = wolli.get(command);
	if (!agent) {
		process.stderr.write(`Unknown agent "${command}". Create it with: ${APP_NAME} new ${command}\n`);
		return 1;
	}
	// A bare `<name> <message>` (inline message without `--print`) has no interactive-send path yet,
	// so reject it rather than silently routing to a single-shot model turn.
	if (message && !args.print) {
		process.stderr.write(
			`Inline messages need --print: ${APP_NAME} ${command} --print "<message>" (or run ${APP_NAME} ${command} for interactive chat)\n`,
		);
		return 1;
	}
	if (args.print) {
		if (!message) {
			process.stderr.write(`Print mode needs a message: ${APP_NAME} ${command} --print "<message>"\n`);
			return 1;
		}
		await agent.connect();
		return runPrintMode(await agent.getLatestSession(), message);
	}
	// Deep-link straight to the chat page.
	const app = new App(wolli);
	await app.start({ to: "chat", name: command });
	return 0;
}
