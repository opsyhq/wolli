/**
 * `steward packages <install|remove|update|list> <agent> [source]` CLI.
 *
 * The package CLI over the per-agent `DefaultPackageManager` — the same package manager
 * that backs `integrations` and resolves extensions/skills/prompts/themes. Per-agent
 * only: no project scope, no trust gating, no self-update; every package is installed
 * into and persisted under the named agent's home.
 */

import chalk from "chalk";
import { createAgentPackageManager } from "./cli/agent-package-manager.ts";
import { APP_NAME } from "./config.ts";
import { agentExists } from "./core/agent-config.ts";

type PackagesCommand = "install" | "remove" | "update" | "list";

interface PackagesCommandOptions {
	command: PackagesCommand;
	agent?: string;
	/** Install/remove/update source (optional for update + list). */
	source?: string;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
}

function getPackagesCommandUsage(command: PackagesCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} packages install <agent> <source>`;
		case "remove":
			return `${APP_NAME} packages remove <agent> <source>`;
		case "update":
			return `${APP_NAME} packages update <agent> [source]`;
		case "list":
			return `${APP_NAME} packages list <agent>`;
	}
}

function printPackagesCommandHelp(command: PackagesCommand): void {
	console.log(`${chalk.bold("Usage:")}
  ${getPackagesCommandUsage(command)}
`);
	switch (command) {
		case "install":
			console.log(`Install a package into an agent and add it to the agent's settings. A package can
contribute extensions, integrations, skills, prompts, and/or themes (declared in its
package.json "steward" field), all resolved in place from the one install.

Sources:
  npm:    ${APP_NAME} packages install <agent> npm:@scope/pkg
  git:    ${APP_NAME} packages install <agent> git:github.com/user/repo
  local:  ${APP_NAME} packages install <agent> ./path/to/package
`);
			return;
		case "remove":
			console.log("Remove a package and its source from the agent's settings.\n");
			return;
		case "update":
			console.log(`Update an agent's installed packages. With a source, update only that package.\n`);
			return;
		case "list":
			console.log("List the packages installed for an agent.\n");
			return;
	}
}

function parsePackagesCommand(args: string[]): PackagesCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackagesCommand | undefined;
	if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let help = false;
	let agent: string | undefined;
	let source: string | undefined;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		if (!agent) {
			agent = arg;
		} else if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	return { command, agent, source, help, invalidOption, invalidArgument };
}

export async function runPackages(rest: string[], help = false): Promise<number> {
	const options = parsePackagesCommand(rest);
	if (!options) {
		const usage = `${APP_NAME} packages <install|remove|update|list> <agent> [source]`;
		if (help) {
			console.log(`Usage: ${usage}`);
			return 0;
		}
		console.error(chalk.red(`Unknown packages command "${rest[0] ?? ""}".`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	if (help || options.help) {
		printPackagesCommandHelp(options.command);
		return 0;
	}

	const usage = getPackagesCommandUsage(options.command);
	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}
	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	if (!options.agent) {
		console.error(chalk.red("Missing agent name."));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}
	if (!agentExists(options.agent)) {
		console.error(chalk.red(`Unknown agent "${options.agent}". Create it with: ${APP_NAME} new ${options.agent}`));
		return 1;
	}

	const { packageManager } = createAgentPackageManager(options.agent);
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install": {
				if (!options.source) {
					console.error(chalk.red("Missing install source."));
					console.error(chalk.dim(`Usage: ${usage}`));
					return 1;
				}
				await packageManager.installAndPersist(options.source);
				console.log(chalk.green(`Installed ${options.source}`));
				return 0;
			}

			case "remove": {
				if (!options.source) {
					console.error(chalk.red("Missing remove source."));
					console.error(chalk.dim(`Usage: ${usage}`));
					return 1;
				}
				const removed = await packageManager.removeAndPersist(options.source);
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${options.source}`));
					return 1;
				}
				console.log(chalk.green(`Removed ${options.source}`));
				return 0;
			}

			case "update": {
				await packageManager.update(options.source);
				console.log(chalk.green(options.source ? `Updated ${options.source}` : "Updated packages"));
				return 0;
			}

			case "list": {
				const configured = packageManager.listConfiguredPackages();
				if (configured.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return 0;
				}
				console.log(chalk.bold("Installed packages:"));
				for (const pkg of configured) {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				}
				return 0;
			}
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		return 1;
	}
}
