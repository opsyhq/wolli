/**
 * `steward integrations <add|remove|list|configure> <agent> <spec>` CLI.
 *
 * Over the per-agent `DefaultPackageManager`: `add`/`remove` install + persist the
 * package, `list` reads the resolved integration resources. `add` also runs guided setup
 * right after install (on a TTY); `configure` re-runs it — both via the standalone
 * onboarding TUI (no agent session).
 */

import chalk from "chalk";
import { createAgentPackageManager } from "./cli/agent-package-manager.ts";
import { runIntegrationOnboarding, runOnboardForInstalledPackage } from "./cli/integration-onboarding.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { agentExists } from "./core/agent-config.ts";

/** Guided setup mounts a TUI, so it only runs on an interactive terminal. */
function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

type IntegrationsCommand = "add" | "remove" | "list" | "configure";

interface IntegrationsCommandOptions {
	command: IntegrationsCommand;
	agent?: string;
	/** Install spec (add/remove) or service id (configure). */
	spec?: string;
	help: boolean;
	invalidArgument?: string;
}

function getIntegrationsCommandUsage(command: IntegrationsCommand): string {
	switch (command) {
		case "add":
			return `${APP_NAME} integrations add <agent> <spec>`;
		case "remove":
			return `${APP_NAME} integrations remove <agent> <spec>`;
		case "list":
			return `${APP_NAME} integrations list <agent>`;
		case "configure":
			return `${APP_NAME} integrations configure <agent> <service>`;
	}
}

function printIntegrationsCommandHelp(command: IntegrationsCommand): void {
	console.log(`${chalk.bold("Usage:")}
  ${getIntegrationsCommandUsage(command)}
`);
	switch (command) {
		case "add":
			console.log(`Install a self-contained integration package into an agent, then run its
guided setup. The package brings its own dependencies and is resolved in place
from its install on the next launch.

Sources:
  npm:    ${APP_NAME} integrations add <agent> npm:@scope/pkg
  git:    ${APP_NAME} integrations add <agent> git:github.com/user/repo
  local:  ${APP_NAME} integrations add <agent> ./path/to/package
`);
			return;
		case "remove":
			console.log(`Remove an installed integration and its source from the agent's settings.
The backing dir is reclaimed only for managed (npm/git) sources — a local install's
source is left untouched.
`);
			return;
		case "list":
			console.log("List installed integrations for an agent.\n");
			return;
		case "configure":
			console.log(`Re-run an integration's guided setup (even if already configured), in a
standalone prompt. Requires an interactive terminal.
`);
			return;
	}
}

function parseIntegrationsCommand(args: string[]): IntegrationsCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: IntegrationsCommand | undefined;
	if (rawCommand === "add" || rawCommand === "remove" || rawCommand === "list" || rawCommand === "configure") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let help = false;
	let agent: string | undefined;
	let spec: string | undefined;
	let invalidArgument: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (!agent) {
			agent = arg;
		} else if (!spec) {
			spec = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	return { command, agent, spec, help, invalidArgument };
}

function resolveAgent(
	agent: string | undefined,
	usage: string,
): { agent: string; agentDir: string } | { error: number } {
	if (!agent) {
		console.error(chalk.red("Missing agent name."));
		console.error(chalk.dim(`Usage: ${usage}`));
		return { error: 1 };
	}
	if (!agentExists(agent)) {
		console.error(chalk.red(`Unknown agent "${agent}". Create it with: ${APP_NAME} new ${agent}`));
		return { error: 1 };
	}
	return { agent, agentDir: getAgentDir(agent) };
}

export async function runIntegrations(rest: string[], help = false): Promise<number> {
	const options = parseIntegrationsCommand(rest);
	if (!options) {
		const usage = `${APP_NAME} integrations <add|remove|list|configure> <agent> [spec]`;
		if (help) {
			console.log(`Usage: ${usage}`);
			return 0;
		}
		console.error(chalk.red(`Unknown integrations command "${rest[0] ?? ""}".`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	// `--help`/`-h` is consumed globally by parseArgs into `help`; the parser's own
	// `options.help` covers the (rare) case it survives in `rest`.
	if (help || options.help) {
		printIntegrationsCommandHelp(options.command);
		return 0;
	}

	const usage = getIntegrationsCommandUsage(options.command);
	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	const resolved = resolveAgent(options.agent, usage);
	if ("error" in resolved) {
		return resolved.error;
	}
	const { agent } = resolved;

	switch (options.command) {
		case "add": {
			if (!options.spec) {
				console.error(chalk.red("Missing install spec."));
				console.error(chalk.dim(`Usage: ${usage}`));
				return 1;
			}
			const { packageManager } = createAgentPackageManager(agent);
			try {
				console.log(chalk.dim(`Installing ${options.spec}...`));
				await packageManager.installAndPersist(options.spec);
				console.log(chalk.green(`Installed ${options.spec}`));
			} catch (error) {
				console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
				return 1;
			}
			// Flow straight into guided setup when interactive; otherwise tell the user how.
			if (isInteractiveTerminal()) {
				return runOnboardForInstalledPackage(agent, options.spec);
			}
			console.log(chalk.dim(`Run "${APP_NAME} integrations configure ${agent} <service>" to set it up.`));
			return 0;
		}

		case "remove": {
			if (!options.spec) {
				console.error(chalk.red("Missing integration to remove."));
				console.error(chalk.dim(`Usage: ${usage}`));
				return 1;
			}
			const { packageManager } = createAgentPackageManager(agent);
			try {
				const removed = await packageManager.removeAndPersist(options.spec);
				if (!removed) {
					console.error(chalk.red(`No matching integration found for ${options.spec}`));
					return 1;
				}
				console.log(chalk.green(`Removed ${options.spec}`));
				return 0;
			} catch (error) {
				console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
				return 1;
			}
		}

		case "list": {
			const { packageManager } = createAgentPackageManager(agent);
			const resolvedPaths = await packageManager.resolve();
			const integrations = resolvedPaths.integrations.filter((r) => r.enabled);
			if (integrations.length === 0) {
				console.log(chalk.dim("No integrations installed."));
				return 0;
			}
			console.log(chalk.bold("Installed integrations:"));
			for (const entry of integrations) {
				console.log(`  ${entry.metadata.source}`);
				console.log(chalk.dim(`    ${entry.path}`));
			}
			return 0;
		}

		case "configure": {
			if (!options.spec) {
				console.error(chalk.red("Missing service name."));
				console.error(chalk.dim(`Usage: ${usage}`));
				return 1;
			}
			if (!isInteractiveTerminal()) {
				console.error(chalk.red("Guided setup requires an interactive terminal."));
				return 1;
			}
			// configure does not install — it runs the integration's guided onboarding in a
			// standalone TUI (no agent session), then exits. The integration goes live on
			// the next `steward <agent>` launch.
			return runIntegrationOnboarding(agent, options.spec);
		}
	}
}
