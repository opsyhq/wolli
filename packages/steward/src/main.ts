/**
 * Real CLI entry point.
 *
 * Mirrors `@opsyhq/coding-agent`'s main.ts — `main(args): Promise<number>` parses
 * argv, intercepts subcommands, then resolves a model, builds the agent via
 * `createAgentSession`, and dispatches to a mode. Phase 1 wires the agent home:
 * `new` / `list` / `<name>`. Interactive mode replaces the print path in Phase 3.
 */

import { createInterface } from "node:readline";
import { type Args, parseArgs, printHelp } from "./cli/args.ts";
import { APP_NAME, VERSION } from "./config.ts";
import { type AgentConfig, agentExists, createAgent, listAgents, loadAgentConfig } from "./core/agent-config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
import { resolveCliModel } from "./core/model-resolver.ts";
import { SessionHost } from "./core/session-host.ts";
import { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
import { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { runPrintMode } from "./modes/print-mode.ts";

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

	const [command, ...rest] = args.positionals;
	if (!command) {
		printHelp();
		return 1;
	}

	if (command === "new") return runNew(rest, args);
	if (command === "list") return runList();
	return runAgent(command, rest, args);
}

async function runNew(positionals: string[], args: Args): Promise<number> {
	const name = positionals[0];
	if (!name) {
		process.stderr.write(`Usage: ${APP_NAME} new <name> [purpose]\n`);
		return 1;
	}
	if (agentExists(name)) {
		process.stderr.write(`Agent "${name}" already exists.\n`);
		return 1;
	}

	let purpose = positionals.slice(1).join(" ").trim();
	if (!purpose) {
		console.log("agent: What is my purpose?");
		purpose = (await readLine("you:   ")).trim();
	}
	if (!purpose) {
		process.stderr.write("A purpose is required.\n");
		return 1;
	}

	let config: AgentConfig;
	try {
		config = createAgent({ name, purpose, model: args.model });
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	console.log(`Created agent "${config.name}".`);
	console.log(`Purpose: ${config.purpose}`);

	// Birth: drop straight into the interactive chat so the agent can get to know
	// its human. (A bare inline/print path has no birth conversation to run.)
	return runSession(name, positionals.slice(1), args);
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
 * Resolve model/auth once, then run the agent — single-shot for inline/`--print`,
 * otherwise the interactive chat. Session construction (env, prompt, tools) and
 * in-place swaps (e.g. after commissioning) are owned by the `SessionHost`.
 */
async function runSession(name: string, positionals: string[], args: Args): Promise<number> {
	const initialConfig = loadAgentConfig(name);

	// Model precedence: --model flag → agent.json → shared pi default → built-in.
	const resolved = resolveCliModel({
		cliProvider: args.provider,
		cliModel: args.model ?? initialConfig.model ?? sharedDefaultModel() ?? DEFAULT_MODEL,
		cliThinking: args.thinking,
	});
	if (resolved.warning) {
		process.stderr.write(`${resolved.warning}\n`);
	}
	if (resolved.error || !resolved.model) {
		process.stderr.write(`${resolved.error ?? "Could not resolve a model."}\n`);
		return 1;
	}
	const model = resolved.model;

	// Auth precedence (handled by AuthStorage): runtime → auth.json (api key / OAuth)
	// → env var. hasAuth() doesn't refresh tokens — it just checks something exists.
	// If it returns false, every credential source (including the env var) is absent,
	// so the only actionable hint is to log in.
	const authStorage = AuthStorage.create();
	if (!authStorage.hasAuth(model.provider)) {
		process.stderr.write(`No credentials found for provider "${model.provider}". Log in with the pi CLI.\n`);
		return 1;
	}

	const thinkingLevel = args.thinking ?? resolved.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const message = positionals.join(" ").trim();

	const host = new SessionHost({ name, model, thinkingLevel, authStorage });

	// `--print` (or a bare inline message) is single-shot; `--print` needs a message.
	if (args.print || message) {
		if (args.print && !message) {
			process.stderr.write(`Print mode needs a message: ${APP_NAME} ${name} --print "<message>"\n`);
			return 1;
		}
		await host.start({ fresh: args.new });
		const code = await runPrintMode(host.harness, { message });
		await host.cleanup();
		return code;
	}

	// Interactive: one long-lived TUI. The host swaps the session in place on
	// commission (see InteractiveMode.handleCommission), so there is no loop here.
	await host.start({ fresh: args.new });
	await new InteractiveMode(host).run();
	await host.cleanup();
	return 0;
}

/**
 * The shared pi default model as a `provider/model` reference (or just the model
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
