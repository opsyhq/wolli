/**
 * Integration onboarding — the CLI-facing runner.
 *
 * `integrations configure <agent> <service>` and the post-install step of
 * `integrations add` both land here. It builds the narrowed `IntegrationOnboardUI` over
 * the short-lived startup-TUI helpers, then drives the UI-agnostic `onboardIntegration`
 * core once per service. This is a CLI sub-flow, not a session mode — no agent session
 * is started.
 *
 * Integration discovery is `resolve()`-based: the per-agent `DefaultPackageManager`
 * resolves the integration half of each configured package in place (no symlinks), and
 * the loaded `Integration` objects carry the definitions to onboard.
 */

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import { IntegrationAccountStorage } from "../core/integration-account-storage.ts";
import { loadIntegrations } from "../core/integrations/loader.ts";
import { onboardIntegration } from "../core/integrations/onboarding.ts";
import type { Integration, IntegrationOnboardUI } from "../core/integrations/types.ts";
import type { DefaultPackageManager } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { createAgentPackageManager } from "./agent-package-manager.ts";
import { showStartupCustom, showStartupInput, showStartupSelector } from "./startup-ui.ts";

/** Build the narrowed onboarding UI over the standalone startup-TUI helpers. */
function createOnboardUi(settingsManager: SettingsManager): IntegrationOnboardUI {
	return {
		select: (title, options) =>
			showStartupSelector(
				settingsManager,
				title,
				options.map((option) => ({ label: option, value: option })),
			),
		confirm: async (title, message) =>
			(await showStartupSelector(settingsManager, `${title}\n${message}`, [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			])) ?? false,
		input: (title, placeholder) => showStartupInput(settingsManager, title, placeholder),
		custom: (factory, options) => showStartupCustom(settingsManager, factory, options),
		// Each prompt is its own short-lived TUI, so notifications print to the console
		// between prompts.
		notify: (message, type = "info") => {
			if (type === "error") {
				console.error(chalk.red(message));
			} else if (type === "warning") {
				console.error(chalk.yellow(message));
			} else {
				console.log(chalk.cyan(message));
			}
		},
	};
}

function isUnder(target: string, root: string): boolean {
	const t = resolve(target);
	const r = resolve(root);
	if (t === r) return true;
	return t.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** Resolve the install root of a just-installed source (for package-scoped onboarding). */
function packageRootForSpec(packageManager: DefaultPackageManager, spec: string): string | undefined {
	// npm/git managed installs resolve cwd-independently; a local source resolves against
	// the shell cwd where `add` was invoked.
	const installed = packageManager.getInstalledPath(spec);
	if (installed) return installed;
	const local = resolvePath(spec, process.cwd());
	return existsSync(local) ? local : undefined;
}

/** Resolve + load the integrations configured for an agent, then drive selected services through onboarding. */
async function runOnboarding(
	agentName: string,
	selectServices: (input: { integrations: Integration[]; packageManager: DefaultPackageManager }) => string[],
): Promise<number> {
	const agentDir = getAgentDir(agentName);
	const { packageManager } = createAgentPackageManager(agentName);
	const resolved = await packageManager.resolve();
	const integrationPaths = resolved.integrations.filter((r) => r.enabled).map((r) => r.path);
	const { integrations, errors } = await loadIntegrations(integrationPaths, agentDir);
	for (const e of errors) {
		console.error(chalk.yellow(`Warning: ${e.error}`));
	}
	const services = selectServices({ integrations, packageManager });
	if (services.length === 0) {
		console.log(chalk.dim("No guided setup available for this integration."));
		return 0;
	}

	const accounts = IntegrationAccountStorage.create(agentName);
	const settingsManager = SettingsManager.create(agentDir);
	const ui = createOnboardUi(settingsManager);

	let exit = 0;
	for (const service of services) {
		const result = await onboardIntegration({ service, integrations, accounts, ui });
		switch (result.status) {
			case "connected":
				console.log(chalk.green(`${service} connected.`));
				console.log(chalk.dim(`Run "steward ${agentName}" to use it.`));
				break;
			case "cancelled":
				console.log(chalk.dim(`${service}: onboarding cancelled.`));
				break;
			case "not-found":
				console.error(chalk.red(`Integration "${service}" is not installed for "${agentName}".`));
				exit = 1;
				break;
			case "no-onboard":
				console.error(chalk.red(`Integration "${service}" has no guided setup.`));
				exit = 1;
				break;
			case "error":
				console.error(chalk.red(`${service}: ${result.message}`));
				exit = 1;
				break;
		}
	}
	return exit;
}

/** `integrations configure <agent> <service>` — re-run one service's guided setup. */
export function runIntegrationOnboarding(agentName: string, service: string): Promise<number> {
	return runOnboarding(agentName, () => [service]);
}

/**
 * Post-install onboarding for `integrations add`: onboard every service declared by the
 * just-installed package that has an `onboard(ctx)`. The package is identified by its
 * install root — the integrations whose resolved path lives under it.
 */
export function runOnboardForInstalledPackage(agentName: string, spec: string): Promise<number> {
	return runOnboarding(agentName, ({ integrations, packageManager }) => {
		const root = packageRootForSpec(packageManager, spec);
		const services: string[] = [];
		for (const integration of integrations) {
			if (root && !isUnder(integration.resolvedPath, root)) continue;
			for (const [service, config] of integration.definitions) {
				if (config.onboard) services.push(service);
			}
		}
		return services;
	});
}
