/**
 * `steward <agent> plugins <install|remove|list|update|configure> [source]` — a daemon client.
 *
 * A plugin is the install/distribution unit: one installed package that can contribute
 * extensions, integrations, skills, prompts, and/or themes (declared in its package.json
 * "steward" field), all resolved in place from the one install. When a plugin contains an
 * integration that declares `onboard`, `install`/`configure` run that guided setup.
 *
 * The mutating arms (install/remove/update) route to the agent's daemon, the single writer: it
 * runs the install/persist primitive against its own resources and reloads itself, so a running
 * daemon never goes stale. `list` is a read-only local view (disk is the source of truth).
 * Onboarding runs in the daemon, which emits each dialog as an `extension_ui_request` frame; the
 * client answers those frames in a standalone startup TUI and prints the per-service results.
 */

import {
	agentExists,
	APP_NAME,
	createAgentPluginManager,
	type ExtensionUIRequest,
	getAgentDir,
	type OnboardServiceResult,
	SettingsManager,
} from "@opsyhq/steward";
import chalk from "chalk";
import { DaemonSession } from "../daemon-session.ts";
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

function getPluginsCommandUsage(agent: string, command: PluginsCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} ${agent} plugins install <source>`;
		case "remove":
			return `${APP_NAME} ${agent} plugins remove <source>`;
		case "list":
			return `${APP_NAME} ${agent} plugins list`;
		case "update":
			return `${APP_NAME} ${agent} plugins update [source]`;
		case "configure":
			return `${APP_NAME} ${agent} plugins configure <source>`;
	}
}

function printPluginsCommandHelp(agent: string, command: PluginsCommand): void {
	console.log(`${chalk.bold("Usage:")}
  ${getPluginsCommandUsage(agent, command)}
`);
	switch (command) {
		case "install":
			console.log(`Install a plugin into an agent and add it to the agent's settings. A plugin can
contribute extensions, integrations, skills, prompts, and/or themes (declared in its
package.json "steward" field), all resolved in place from the one install. When the plugin
contains an integration with guided setup, onboarding runs automatically.

Sources:
  npm:    ${APP_NAME} ${agent} plugins install npm:@scope/pkg
  git:    ${APP_NAME} ${agent} plugins install git:github.com/user/repo
  local:  ${APP_NAME} ${agent} plugins install ./path/to/plugin
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

/**
 * Client half of the onboarding round-trip: a daemon-side `onboard(ctx)` dialog arrives as an
 * `extension_ui_request` frame. Render it in the standalone startup TUI and answer over `/ui-response`
 * (value/cancelled shaping as in the interactive client's own `dispatchUiRequest`). Only
 * `select`/`confirm`/`input`/`notify` occur — the narrowed `IntegrationOnboardUI`.
 */
async function dispatchUiRequest(
	session: DaemonSession,
	settingsManager: SettingsManager,
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
			// Each startup dialog is its own short-lived TUI, so notifications print between prompts.
			if (req.notifyType === "error") {
				console.error(chalk.red(req.message));
			} else if (req.notifyType === "warning") {
				console.error(chalk.yellow(req.message));
			} else {
				console.log(chalk.cyan(req.message));
			}
			return;
		// Any other method can't arise from the narrowed onboarding UI — ignore it.
	}
}

/**
 * Print the daemon's structured per-service onboarding results client-side (the old status switch).
 * `emptyMessage` is printed when there are no onboarding integrations — install suppresses it (an
 * extension-only plugin installs cleanly), `configure` surfaces it.
 */
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
				console.log(chalk.dim(`Run "${APP_NAME} ${agent}" to use it.`));
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
		const usage = `${APP_NAME} ${agent} plugins <install|remove|list|update|configure> [source]`;
		if (help) {
			console.log(`Usage: ${usage}`);
			return 0;
		}
		console.error(chalk.red(`Unknown plugins command "${rest[0] ?? ""}".`));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	// `--help`/`-h` is consumed globally by parseArgs into `help`; the parser's own
	// `options.help` covers the (rare) case it survives in `rest`.
	if (help || options.help) {
		printPluginsCommandHelp(agent, options.command);
		return 0;
	}

	const usage = getPluginsCommandUsage(agent, options.command);
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

	if (!agentExists(agent)) {
		console.error(chalk.red(`Unknown agent "${agent}". Create it with: ${APP_NAME} new ${agent}`));
		return 1;
	}

	// Require the source up front (install/remove/configure) so we never spawn a daemon just to usage-error.
	if (
		(options.command === "install" || options.command === "remove" || options.command === "configure") &&
		!options.source
	) {
		console.error(chalk.red("Missing plugin source."));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}

	// `list` is a read-only local view — disk is the source of truth, no stale risk, no daemon needed.
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

		// Second section: the integrations these plugins (and auto-discovery) contribute — the view
		// the old `integrations list` showed, reusing the same resolve() call (local/offline-capable).
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

	// Guided setup mounts a TUI — reject `configure` early (before spawning a daemon) when headless.
	if (options.command === "configure" && !isInteractiveTerminal()) {
		console.error(chalk.red("Guided setup requires an interactive terminal."));
		return 1;
	}

	// Mutating arms route to the daemon (the single writer).
	const session = await DaemonSession.open(agent);
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
				// Flow straight into guided setup when interactive; otherwise tell the user how.
				if (!isInteractiveTerminal()) {
					console.log(chalk.dim(`Run "${APP_NAME} ${agent} plugins configure ${source}" to set it up.`));
					return 0;
				}
				const settingsManager = SettingsManager.create(getAgentDir(agent));
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
				const settingsManager = SettingsManager.create(getAgentDir(agent));
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
		session.close();
	}
}
