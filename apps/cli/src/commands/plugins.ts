/**
 * `wolli <agent> plugins <install|remove|list|update|configure> [source]`.
 *
 * install/remove/update route to the agent's daemon (the single writer, which reloads itself);
 * list reads disk locally. If a plugin's integration declares `onboard`, install/configure run
 * that guided setup over the daemon's `extension_ui_request` round-trip, rendered in a startup TUI.
 */

import {
	AgentSettingsManager,
	APP_NAME,
	createAgentPluginManager,
	type ExtensionUIRequest,
	type OnboardServiceResult,
	type SessionHandle,
	Wolli,
} from "@opsyhq/wolli";
import chalk from "chalk";
import { showStartupInput, showStartupSelector } from "../startup-ui.ts";

/** Guided setup mounts a TUI, so it only runs on an interactive terminal. */
function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

type PluginsCommand = "install" | "remove" | "list" | "update" | "configure";

interface PluginsCommandOptions {
	command: PluginsCommand;
	/** Install/remove/configure source (optional for update + list). */
	source?: string;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
}

function getPluginsCommandUsage(command: PluginsCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} <agent> plugins install <source>`;
		case "remove":
			return `${APP_NAME} <agent> plugins remove <source>`;
		case "list":
			return `${APP_NAME} <agent> plugins list`;
		case "update":
			return `${APP_NAME} <agent> plugins update [source]`;
		case "configure":
			return `${APP_NAME} <agent> plugins configure <source>`;
	}
}

function printPluginsCommandHelp(command: PluginsCommand): void {
	console.log(`${chalk.bold("Usage:")}
  ${getPluginsCommandUsage(command)}
`);
	switch (command) {
		case "install":
			console.log(`Install a plugin into an agent and add it to the agent's settings. A plugin can
contribute extensions, integrations, skills, prompts, and/or themes (declared in its
package.json "wolli" field), all resolved in place from the one install. When the plugin
contains an integration with guided setup, onboarding runs automatically.

Sources:
  npm:    ${APP_NAME} <agent> plugins install npm:@scope/pkg
  git:    ${APP_NAME} <agent> plugins install git:github.com/user/repo
  local:  ${APP_NAME} <agent> plugins install ./path/to/plugin
`);
			return;
		case "remove":
			console.log("Remove a plugin and its source from the agent's settings.\n");
			return;
		case "list":
			console.log("List the plugins installed for an agent, and the integrations they contribute.\n");
			return;
		case "update":
			console.log(`Update an agent's installed plugins. With a source, update only that plugin.\n`);
			return;
		case "configure":
			console.log(`Re-run a plugin's guided setup (even if already configured), in a standalone
prompt. Requires an interactive terminal.
`);
			return;
	}
}

function parsePluginsCommand(rest: string[]): PluginsCommandOptions | undefined {
	const [rawCommand, ...verbArgs] = rest;
	let command: PluginsCommand | undefined;
	if (
		rawCommand === "install" ||
		rawCommand === "remove" ||
		rawCommand === "list" ||
		rawCommand === "update" ||
		rawCommand === "configure"
	) {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let help = false;
	let source: string | undefined;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;

	for (const arg of verbArgs) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	return { command, source, help, invalidOption, invalidArgument };
}

/** Render one daemon-side onboarding dialog in the startup TUI and answer it over `/ui-response`. */
async function dispatchUiRequest(
	session: SessionHandle,
	settingsManager: AgentSettingsManager,
	req: ExtensionUIRequest,
): Promise<void> {
	switch (req.method) {
		case "select": {
			const value = await showStartupSelector(
				settingsManager,
				req.title,
				req.options.map((option) => ({ label: option, value: option })),
			);
			void session.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
			return;
		}
		case "confirm": {
			const value = await showStartupSelector(settingsManager, `${req.title}\n${req.message}`, [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			]);
			void session.respondUi(req.id, value === undefined ? { cancelled: true } : { confirmed: value });
			return;
		}
		case "input": {
			const value = await showStartupInput(settingsManager, req.title, req.placeholder);
			void session.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
			return;
		}
		case "notify":
			if (req.notifyType === "error") {
				console.error(chalk.red(req.message));
			} else if (req.notifyType === "warning") {
				console.error(chalk.yellow(req.message));
			} else {
				console.log(chalk.cyan(req.message));
			}
			return;
		// Other methods can't arise from onboarding's narrowed UI.
	}
}

/** Print per-service onboarding results; `emptyMessage` shows when the plugin onboarded nothing. */
function printOnboardResults(agent: string, results: OnboardServiceResult[], emptyMessage?: string): number {
	if (results.length === 0) {
		if (emptyMessage) {
			console.log(chalk.dim(emptyMessage));
		}
		return 0;
	}
	let exit = 0;
	for (const { service, status, message } of results) {
		switch (status) {
			case "connected":
				console.log(chalk.green(`${service} connected.`));
				console.log(chalk.dim(`Restart the agent for it to take effect: ${APP_NAME} restart ${agent}`));
				break;
			case "cancelled":
				console.log(chalk.dim(`${service}: onboarding cancelled.`));
				break;
			case "not-found":
				console.error(chalk.red(`Integration "${service}" is not installed for "${agent}".`));
				exit = 1;
				break;
			case "no-onboard":
				console.error(chalk.red(`Integration "${service}" has no guided setup.`));
				exit = 1;
				break;
			case "error":
				console.error(chalk.red(`${service}: ${message}`));
				exit = 1;
				break;
		}
	}
	return exit;
}

export async function runPlugins(agent: string, rest: string[], help = false): Promise<number> {
	const options = parsePluginsCommand(rest);
	if (!options) {
		const usage = `${APP_NAME} <agent> plugins <install|remove|list|update|configure> [source]`;
		if (help) {
			console.log(`Usage: ${usage}`);
			return 0;
		}
		console.error(chalk.red(`Unknown plugins command "${rest[0] ?? ""}".`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	if (help || options.help) {
		printPluginsCommandHelp(options.command);
		return 0;
	}

	const usage = getPluginsCommandUsage(options.command);
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

	const handle = new Wolli().get(agent);
	if (!handle) {
		console.error(chalk.red(`Unknown agent "${agent}". Create it with: ${APP_NAME} new ${agent}`));
		return 1;
	}

	// Require the source up front so we don't spawn a daemon just to usage-error.
	if (
		(options.command === "install" || options.command === "remove" || options.command === "configure") &&
		!options.source
	) {
		console.error(chalk.red("Missing plugin source."));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	// list reads disk locally — no daemon needed.
	if (options.command === "list") {
		const { pluginManager } = createAgentPluginManager(agent);
		const configured = pluginManager.listConfiguredPlugins();
		if (configured.length === 0) {
			console.log(chalk.dim("No plugins installed."));
		} else {
			console.log(chalk.bold("Installed plugins:"));
			for (const plugin of configured) {
				const display = plugin.filtered ? `${plugin.source} (filtered)` : plugin.source;
				console.log(`  ${display}`);
				if (plugin.installedPath) {
					console.log(chalk.dim(`    ${plugin.installedPath}`));
				}
			}
		}

		// Plus the integrations these plugins (and auto-discovery) contribute.
		const resolvedPaths = await pluginManager.resolve();
		const integrations = resolvedPaths.integrations.filter((r) => r.enabled);
		if (integrations.length > 0) {
			console.log(chalk.bold("Integrations:"));
			for (const entry of integrations) {
				console.log(`  ${entry.metadata.source}`);
				console.log(chalk.dim(`    ${entry.path}`));
			}
		}
		return 0;
	}

	// Guided setup mounts a TUI — reject configure early (before spawning a daemon) when headless.
	if (options.command === "configure" && !isInteractiveTerminal()) {
		console.error(chalk.red("Guided setup requires an interactive terminal."));
		return 1;
	}

	await handle.connect();
	const session = await handle.getLatestSession();
	try {
		switch (options.command) {
			case "install": {
				const source = options.source as string;
				try {
					console.log(chalk.dim(`Installing ${source}...`));
					await session.installPlugin(source);
					console.log(chalk.green(`Installed ${source}`));
				} catch (error) {
					console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
					return 1;
				}
				// Onboard now if interactive; otherwise point at configure.
				if (!isInteractiveTerminal()) {
					console.log(chalk.dim(`Run "${APP_NAME} ${agent} plugins configure ${source}" to set it up.`));
					return 0;
				}
				const settingsManager = AgentSettingsManager.create(agent);
				session.onUiRequest = (req) => void dispatchUiRequest(session, settingsManager, req);
				return printOnboardResults(agent, await session.onboardPlugin(source));
			}

			case "remove": {
				const { removed } = await session.removePlugin(options.source as string);
				if (!removed) {
					console.error(chalk.red(`No matching plugin found for ${options.source}`));
					return 1;
				}
				console.log(chalk.green(`Removed ${options.source}`));
				return 0;
			}

			case "update":
				await session.updatePlugins(options.source);
				console.log(chalk.green(options.source ? `Updated ${options.source}` : "Updated plugins"));
				return 0;

			case "configure": {
				const settingsManager = AgentSettingsManager.create(agent);
				session.onUiRequest = (req) => void dispatchUiRequest(session, settingsManager, req);
				return printOnboardResults(
					agent,
					await session.onboardPlugin(options.source as string),
					"No guided setup available for this plugin.",
				);
			}
		}
		return 0;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		return 1;
	} finally {
		// Close the whole agent connection, not just this session: connect() opened the control
		// stream too, and leaving it open keeps the process alive (the command never exits).
		handle.close();
	}
}
