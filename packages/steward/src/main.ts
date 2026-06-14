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
import { APP_NAME, getAgentDir, VERSION } from "./config.ts";
import {
	type AgentConfig,
	agentExists,
	createAgent,
	isCommissioned,
	listAgents,
	loadAgentConfig,
} from "./core/agent-config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
import { loadMemory } from "./core/memory.ts";
import { resolveCliModel } from "./core/model-resolver.ts";
import { createAgentSession } from "./core/sdk.ts";
import { openAgentSession } from "./core/session.ts";
import { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { createBashTool } from "./core/tools/bash.ts";
import { createMemoryTool } from "./core/tools/memory.ts";
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
 * otherwise the interactive chat. Interactive mode loops: when the agent is
 * commissioned in-chat (`/commission`), `run()` resolves `{ restart: true }` and
 * we reopen a fresh session whose prompt no longer carries the birth instruction
 * (the system prompt is frozen for a session's lifetime, so a restart is required).
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

	// `--print` forces single-shot mode; it requires an inline message.
	if (args.print || message) {
		if (args.print && !message) {
			process.stderr.write(`Print mode needs a message: ${APP_NAME} ${name} --print "<message>"\n`);
			return 1;
		}
		const { session, env } = await openAgentSession(name, { fresh: args.new });
		const { soul, memory, user } = loadMemory(name);
		const systemPrompt = buildSystemPrompt({ config: initialConfig, soul, memory, user });
		const { harness } = await createAgentSession({
			env,
			session,
			model,
			systemPrompt,
			thinkingLevel,
			tools: [createMemoryTool(name), createBashTool(env, getAgentDir(name))],
			authStorage,
		});
		return runPrintMode(harness, { message });
	}

	// Interactive: loop so an in-chat commission can restart into a fresh session.
	let fresh = args.new;
	while (true) {
		// Re-read: commissionedAt may have changed since the previous iteration.
		const config = loadAgentConfig(name);
		const { session, env } = await openAgentSession(name, { fresh });

		// Read curated files ONCE and freeze them into the prompt. Mid-session edits
		// (memory tool / bash) persist to disk but only enter the prompt next session.
		const { soul, memory, user } = loadMemory(name);
		const systemPrompt = buildSystemPrompt({ config, soul, memory, user });

		const { harness } = await createAgentSession({
			env,
			session,
			model,
			systemPrompt,
			thinkingLevel,
			tools: [createMemoryTool(name), createBashTool(env, getAgentDir(name))],
			authStorage,
		});

		const { restart } = await new InteractiveMode(harness, {
			name,
			purpose: config.purpose,
			commissioned: isCommissioned(config),
		}).run();
		if (!restart) break;
		fresh = true; // commissioned → start a clean session (birth instruction gone)
	}
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
