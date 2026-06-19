/**
 * `steward integrations <add|remove|list|configure> <agent> <spec>` — a daemon client.
 *
 * Onboarding runs in the agent: the daemon installs the package and drives the integration's
 * `onboard(ctx)` against its own live account store, emitting each dialog as an `extension_ui_request`
 * frame. The client opens a daemon session, answers those frames in a standalone startup TUI (one
 * short-lived dialog per question), and prints the structured per-service results. `list` is a
 * read-only local view (disk is the source of truth).
 */

import {
	agentExists,
	APP_NAME,
	createAgentPackageManager,
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

/**
 * Client half of the onboarding round-trip: a daemon-side `onboard(ctx)` dialog arrives as an
 * `extension_ui_request` frame. Render it in the standalone startup TUI and answer over `/ui-response`
 * (value/cancelled shaping as in the interactive client). Only `select`/`confirm`/`input`/`notify`
 * occur — the narrowed `IntegrationOnboardUI`.
 */
async function dispatchOnboardDialog(
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

/** Print the daemon's structured per-service onboarding results client-side (the old status switch). */
function printOnboardResults(agent: string, results: OnboardServiceResult[]): number {
	if (results.length === 0) {
		console.log(chalk.dim("No guided setup available for this integration."));
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

	if (!options.agent) {
		console.error(chalk.red("Missing agent name."));
		console.error(chalk.dim(`Usage: ${usage}`));
		return 1;
	}
	if (!agentExists(options.agent)) {
		console.error(chalk.red(`Unknown agent "${options.agent}". Create it with: ${APP_NAME} new ${options.agent}`));
		return 1;
	}
	const agent = options.agent;

	switch (options.command) {
		case "add": {
			if (!options.spec) {
				console.error(chalk.red("Missing install spec."));
				console.error(chalk.dim(`Usage: ${usage}`));
				return 1;
			}
			const spec = options.spec;
			const session = await DaemonSession.open(agent);
			try {
				try {
					console.log(chalk.dim(`Installing ${spec}...`));
					await session.installPackage(spec);
					console.log(chalk.green(`Installed ${spec}`));
				} catch (error) {
					console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
					return 1;
				}
				// Flow straight into guided setup when interactive; otherwise tell the user how.
				if (!isInteractiveTerminal()) {
					console.log(chalk.dim(`Run "${APP_NAME} integrations configure ${agent} <service>" to set it up.`));
					return 0;
				}
				const settingsManager = SettingsManager.create(getAgentDir(agent));
				session.onUiRequest = (req) => void dispatchOnboardDialog(session, settingsManager, req);
				return printOnboardResults(agent, await session.onboardPackage(spec));
			} finally {
				session.close();
			}
		}

		case "remove": {
			if (!options.spec) {
				console.error(chalk.red("Missing integration to remove."));
				console.error(chalk.dim(`Usage: ${usage}`));
				return 1;
			}
			const session = await DaemonSession.open(agent);
			try {
				const { removed } = await session.removePackage(options.spec);
				if (!removed) {
					console.error(chalk.red(`No matching integration found for ${options.spec}`));
					return 1;
				}
				console.log(chalk.green(`Removed ${options.spec}`));
				return 0;
			} catch (error) {
				console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
				return 1;
			} finally {
				session.close();
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
			const session = await DaemonSession.open(agent);
			try {
				const settingsManager = SettingsManager.create(getAgentDir(agent));
				session.onUiRequest = (req) => void dispatchOnboardDialog(session, settingsManager, req);
				return printOnboardResults(agent, await session.onboardIntegration(options.spec));
			} finally {
				session.close();
			}
		}
	}
}
