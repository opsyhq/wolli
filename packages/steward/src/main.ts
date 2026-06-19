/**
 * Engine CLI entry point.
 *
 * `main(argv)` handles only `--help` / `--version` for the `@opsyhq/cli` client, which delegates
 * them here. Every agent surface (`new` / `list` / `delete` / `integrations` / `packages` /
 * interactive / `--print`) lives in `@opsyhq/cli`; the daemon runner is the exported `runDaemon`.
 */

import { randomBytes } from "node:crypto";
import type { ThinkingLevel } from "@opsyhq/agent";
import { parseArgs, printHelp } from "./cli/args.ts";
import { APP_NAME, ENV_DAEMON_TOKEN, VERSION } from "./config.ts";
import { type AgentConfig, agentExists, isDeployed, loadAgentConfig } from "./core/agent-config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { loadDaemonConfig, saveDaemonConfig } from "./core/daemon-config.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
import { IntegrationAccountStorage } from "./core/integration-account-storage.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel } from "./core/model-resolver.ts";
import { SessionHost } from "./core/session-host.ts";
import { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
import { runDaemonMode } from "./modes/daemon/daemon-mode.ts";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.help) {
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

	const [command] = args.positionals;
	if (!command) {
		printHelp();
		return 1;
	}

	// Agent surfaces (`new`/`list`/`delete`/`integrations`/`packages`/interactive/`--print`) and the
	// `daemon` runner are owned by the `@opsyhq/cli` client; the engine never dispatches them.
	process.stderr.write(`Unknown command "${command}".\n`);
	return 1;
}

/**
 * Resolve model/auth once and construct the `SessionHost` — the front half of the daemon runner.
 * Returns the unstarted `host` plus the `config` it was built from (the caller needs `config` for
 * the `fresh` decision), or an `{ error }` for the model/auth failures that should print to stderr
 * and exit 1.
 */
function createAgentSessionHost(
	name: string,
	opts: { provider?: string; model?: string; thinking?: ThinkingLevel },
): { host: SessionHost; config: AgentConfig } | { error: string } {
	const config = loadAgentConfig(name);

	const authStorage = AuthStorage.create();
	// Integration accounts are per-agent (`~/.steward/agents/<name>/integrations.json`).
	const integrationAccounts = IntegrationAccountStorage.create(name);
	const modelRegistry = ModelRegistry.create(authStorage);

	// Model precedence: --model flag → agent.json → shared default → built-in.
	const resolved = resolveCliModel({
		cliProvider: opts.provider,
		cliModel: opts.model ?? config.model ?? sharedDefaultModel() ?? DEFAULT_MODEL,
		cliThinking: opts.thinking,
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

	const thinkingLevel = opts.thinking ?? resolved.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const host = new SessionHost({ name, model, thinkingLevel, authStorage, integrationAccounts });
	return { host, config };
}

export interface RunDaemonOptions {
	/** Manual bind-port override for this run (debugging); 0/absent → OS-assigned ephemeral. */
	port?: number;
	/** Start a fresh session — honored only once deployed (a forming agent stays in its birth session). */
	fresh?: boolean;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * The `daemon <name>` runner: start the agent's `SessionHost`, then wrap it in a long-running
 * HTTP/SSE server clients attach to. Binds an OS-assigned ephemeral port (unless `--port` overrides),
 * writes the pid/port/token to the temp-dir config so clients can find it, and blocks on the listening
 * server until a signal tears it down. The `@opsyhq/cli` client's hidden `daemon` subcommand and every
 * OS service unit invoke this.
 */
export async function runDaemon(name: string, opts: RunDaemonOptions = {}): Promise<number> {
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}

	const built = createAgentSessionHost(name, opts);
	if ("error" in built) {
		process.stderr.write(`${built.error}\n`);
		return 1;
	}
	const { host, config } = built;

	// A forming agent stays in its single birth session; `fresh` only takes effect once deployed.
	const fresh = isDeployed(config) ? Boolean(opts.fresh) : false;
	await host.start({ fresh });

	// Every daemon binds an OS-assigned ephemeral port and writes it back to the temp config, where
	// clients discover it — no port is reserved up front. This is also what lets deploy stand up the
	// supervised daemon alongside the still-serving birth daemon: two ephemeral binds never collide.
	// `--port` is a manual override for this run (e.g. to pin a known port for debugging).
	const port = opts.port ?? 0;

	// Bearer token for /events + /control: the STEWARD_DAEMON_TOKEN override, else a fresh 256-bit hex.
	const token = process.env[ENV_DAEMON_TOKEN]?.trim() || randomBytes(32).toString("hex");
	saveDaemonConfig(name, {
		pid: process.pid,
		port,
		token,
		startedAt: new Date().toISOString(),
		version: VERSION,
	});

	const server = await runDaemonMode(host, { port, token });
	// runDaemonMode patches the config with the OS-assigned port once listening.
	const boundPort = loadDaemonConfig(name)?.port ?? port;
	console.log(`${APP_NAME} daemon for "${name}" listening on http://127.0.0.1:${boundPort}`);

	// server.close() drops the broadcaster subscription (via the server's "close" listener); we then
	// release the host + config.
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		await host.cleanup();
		// No deleteDaemonConfig here: the config is a health-validated discovery hint, and a deploy
		// handoff's supervised successor may already own it.
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
