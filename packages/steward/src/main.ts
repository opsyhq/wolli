/**
 * Real CLI entry point.
 *
 * `main(args): Promise<number>` parses argv, intercepts subcommands, then
 * resolves a model, builds the agent via `createAgentSession`, and dispatches to
 * a mode. Subcommands wire the agent home: `new` / `list` / `<name>`.
 */

import { createInterface } from "node:readline";
import { type Args, parseArgs, printHelp } from "./cli/args.ts";
import { APP_NAME, getAgentDir, VERSION } from "./config.ts";
import {
	type AgentConfig,
	agentExists,
	deleteAgent,
	isDeployed,
	listAgents,
	loadAgentConfig,
} from "./core/agent-config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import {
	deleteDaemonDescriptor,
	loadDaemonDescriptor,
	mintDaemonToken,
	saveDaemonDescriptor,
} from "./core/daemon-descriptor.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
import { IntegrationAccountStorage } from "./core/integration-account-storage.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel } from "./core/model-resolver.ts";
import { SessionHost } from "./core/session-host.ts";
import { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
import { runIntegrations } from "./integrations-cli.ts";
import { runDaemonMode } from "./modes/daemon/daemon-mode.ts";
import { runPrintMode } from "./modes/print-mode.ts";
import { runPackages } from "./package-manager-cli.ts";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	// `integrations`/`packages` own their per-subcommand help, so don't let the global
	// --help intercept swallow `<cmd> --help`.
	if (args.help && args.positionals[0] !== "integrations" && args.positionals[0] !== "packages") {
		printHelp();
		return 0;
	}
	if (args.version) {
		console.log(`${APP_NAME} ${VERSION}`);
		return 0;
	}

	for (const diagnostic of args.diagnostics) {
		process.stderr.write(`${diagnostic.message}\n`);
	}

	const [command, ...rest] = args.positionals;
	if (!command) {
		printHelp();
		return 1;
	}

	if (command === "list") return runList();
	if (command === "delete") return runDelete(rest);
	if (command === "integrations") return runIntegrations(rest, args.help);
	if (command === "packages") return runPackages(rest, args.help);
	if (command === "daemon") return runDaemon(rest, args);
	return runAgent(command, rest, args);
}

async function runDelete(positionals: string[]): Promise<number> {
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} delete <name>\n`);
		return 1;
	}
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}".\n`);
		return 1;
	}

	console.log(`This will delete agent "${name}" and all of its memory, sessions, and workspace:`);
	console.log(`  ${getAgentDir(name)}`);
	console.log(`Type ${name} to confirm:`);
	const answer = (await readLine("")).trim();
	if (answer !== name) {
		console.log("Delete cancelled.");
		return 1;
	}

	const result = deleteAgent(name);
	if (!result.ok) {
		process.stderr.write(`Failed to delete agent "${name}": ${result.error ?? "unknown error"}\n`);
		return 1;
	}
	console.log(`Deleted agent "${name}".`);
	return 0;
}

function runList(): number {
	const agents = listAgents();
	if (agents.length === 0) {
		console.log(`No agents yet. Create one with: ${APP_NAME} new <name>`);
		return 0;
	}
	for (const agent of agents) {
		const purpose = agent.purpose.trim().replace(/\s+/g, " ");
		const summary = purpose.length > 72 ? `${purpose.slice(0, 69)}...` : purpose;
		console.log(`${agent.name}  —  ${summary}`);
	}
	return 0;
}

async function runAgent(name: string, positionals: string[], args: Args): Promise<number> {
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}
	return runSession(name, positionals, args);
}

/**
 * Resolve model/auth once and construct the `SessionHost` — the shared front half of
 * every agent-running command (`runSession`, `runDaemon`). Returns the unstarted `host`
 * plus the `config` it was built from (callers need `config` for the `fresh` decision),
 * or an `{ error }` for the model/auth failures that should print to stderr and exit 1.
 */
function createAgentSessionHost(
	name: string,
	args: Args,
): { host: SessionHost; config: AgentConfig } | { error: string } {
	const config = loadAgentConfig(name);

	const authStorage = AuthStorage.create();
	// Integration accounts are per-agent (`~/.steward/agents/<name>/integrations.json`).
	const integrationAccounts = IntegrationAccountStorage.create(name);
	const modelRegistry = ModelRegistry.create(authStorage);

	// Model precedence: --model flag → agent.json → shared default → built-in.
	const resolved = resolveCliModel({
		cliProvider: args.provider,
		cliModel: args.model ?? config.model ?? sharedDefaultModel() ?? DEFAULT_MODEL,
		cliThinking: args.thinking,
		modelRegistry,
	});
	if (resolved.warning) {
		process.stderr.write(`${resolved.warning}\n`);
	}
	if (resolved.error || !resolved.model) {
		return { error: resolved.error ?? "Could not resolve a model." };
	}
	const model = resolved.model;

	// Auth precedence (handled by AuthStorage): runtime → auth.json (api key / OAuth)
	// → env var. hasAuth() doesn't refresh tokens — it just checks something exists.
	// If it returns false, every credential source (including the env var) is absent,
	// so the only actionable hint is to log in.
	if (!authStorage.hasAuth(model.provider)) {
		return { error: `No credentials found for provider "${model.provider}". Log in with the steward CLI.` };
	}

	const thinkingLevel = args.thinking ?? resolved.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const host = new SessionHost({ name, model, thinkingLevel, authStorage, integrationAccounts });
	return { host, config };
}

/**
 * Run a single-shot `--print` / inline-message turn in-process. The interactive TUI is no
 * longer served here — it runs in the `@opsyhq/cli` client against the agent's daemon — so a
 * bare `<name>` with no message is rejected (the client owns that path). `--print` becomes a
 * daemon client in Slice 2; until then it stays in-process.
 */
async function runSession(name: string, positionals: string[], args: Args): Promise<number> {
	const built = createAgentSessionHost(name, args);
	if ("error" in built) {
		process.stderr.write(`${built.error}\n`);
		return 1;
	}
	const { host, config } = built;
	const message = positionals.join(" ").trim();

	if (!args.print && !message) {
		process.stderr.write("Interactive sessions are served by the steward CLI client, not the engine.\n");
		return 1;
	}
	if (args.print && !message) {
		process.stderr.write(`Print mode needs a message: ${APP_NAME} ${name} --print "<message>"\n`);
		return 1;
	}

	// A forming agent stays in its single birth session; `--new` only takes effect once deployed.
	const fresh = isDeployed(config) ? Boolean(args.new) : false;
	await host.start({ fresh });
	const code = await runPrintMode(host.harness, { message });
	await host.cleanup();
	return code;
}

/**
 * Hidden `daemon <name>` subcommand: start the agent's `SessionHost` and wrap it in a
 * long-running HTTP/SSE server clients attach to. Binds the agent's stable port (its durable
 * identity in agent.json), then writes the ephemeral pid/port/token descriptor to the temp dir
 * so attach clients can find it, and blocks on the listening server until a signal tears it down.
 */
async function runDaemon(positionals: string[], args: Args): Promise<number> {
	const name = positionals[0];
	if (!name) {
		process.stderr.write(`Usage: ${APP_NAME} daemon <name> [--port <n>]\n`);
		return 1;
	}
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}

	const built = createAgentSessionHost(name, args);
	if ("error" in built) {
		process.stderr.write(`${built.error}\n`);
		return 1;
	}
	const { host, config } = built;

	// Same rule as runSession: `--new` only applies once deployed.
	const fresh = isDeployed(config) ? Boolean(args.new) : false;
	await host.start({ fresh });

	// The port the daemon prefers to bind: the agent's durable identity in agent.json, with
	// `--port` as a transient override for this run. 0/absent means let the OS assign one.
	const port = args.port ?? config.port ?? 0;

	// pid/port/token are ephemeral runtime state — the temp-dir descriptor, not agent.json.
	// runDaemonMode patches `port` to the actual bound port once listening (matters when 0).
	const token = mintDaemonToken();
	saveDaemonDescriptor(name, {
		pid: process.pid,
		port,
		token,
		startedAt: new Date().toISOString(),
		version: VERSION,
	});

	const server = await runDaemonMode(host, { port, token });
	// runDaemonMode patches the descriptor with the OS-assigned port once listening.
	const boundPort = loadDaemonDescriptor(name)?.port ?? port;
	console.log(`${APP_NAME} daemon for "${name}" listening on http://127.0.0.1:${boundPort}`);

	// steward has no existing signal handler to reuse. server.close() drops the broadcaster
	// subscription (via the server's "close" listener); we then release the env + descriptor.
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		await host.cleanup();
		deleteDaemonDescriptor(name);
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	// The listening server keeps the event loop alive; block until a signal exits.
	return new Promise<number>(() => {});
}

/**
 * The shared default model as a `provider/model` reference (or just the model
 * id when no provider is set), read from `~/.steward/agent/settings.json`. Used
 * to seed model resolution when neither `--model` nor agent.json picks a model.
 */
function sharedDefaultModel(): string | undefined {
	const model = getDefaultModel();
	if (!model) return undefined;
	const provider = getDefaultProvider();
	return provider ? `${provider}/${model}` : model;
}

function readLine(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	return new Promise((resolve) => {
		rl.once("line", (line) => {
			// Resolve before close(): close() synchronously emits "close", whose
			// handler would otherwise resolve("") first and win.
			resolve(line);
			rl.close();
		});
		rl.once("close", () => resolve(""));
	});
}
