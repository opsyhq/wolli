/**
 * Integration loader. Loads TypeScript integration modules with jiti from the
 * paths the package manager's `resolve()` surfaces, and exposes the definer-side
 * `IntegrationsAPI`. Definitions are written to the integration's `definitions`
 * map directly at load time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../extensions/loader.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type {
	Integration,
	IntegrationConfig,
	IntegrationFactory,
	IntegrationRuntime,
	IntegrationsAPI,
	LoadIntegrationsResult,
} from "./types.ts";

/**
 * Create a runtime with no-op registration stubs.
 *
 * Definitions are written to the integration map directly by the API, so the
 * pre-bind `registerIntegration`/`unregisterIntegration` are no-ops. `bindCore()`
 * on the runner replaces them with live implementations for post-bind effect.
 */
export function createIntegrationRuntime(): IntegrationRuntime {
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: IntegrationRuntime = {
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This integration ctx is stale after a reload. Do not register against a captured steward after reload.";
		},
		// Pre-bind no-ops: the API writes definitions directly. bindCore() rebinds these.
		registerIntegration: () => {},
		unregisterIntegration: () => {},
	};

	return runtime;
}

/** Default service name for a config without an explicit `name`. */
function defaultServiceName(integrationPath: string): string {
	if (integrationPath.startsWith("<") && integrationPath.endsWith(">")) {
		return integrationPath.slice(1, -1).split(":")[0] || "integration";
	}
	return path.basename(integrationPath, path.extname(integrationPath));
}

/**
 * Create the IntegrationsAPI for an integration. Registration writes to the
 * integration's `definitions` map directly, then notifies the runtime (a no-op
 * pre-bind, live once the runner's `bindCore()` has rebound it).
 */
function createIntegrationAPI(integration: Integration, runtime: IntegrationRuntime): IntegrationsAPI {
	return {
		registerIntegration(config: IntegrationConfig): void {
			runtime.assertActive();
			const name = config.name ?? defaultServiceName(integration.path);
			integration.definitions.set(name, config);
			runtime.registerIntegration(config, integration.path);
		},

		unregisterIntegration(name: string): void {
			runtime.assertActive();
			integration.definitions.delete(name);
			runtime.unregisterIntegration(name, integration.path);
		},
	};
}

async function loadIntegrationModule(integrationPath: string): Promise<IntegrationFactory | undefined> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const realPath = fs.existsSync(integrationPath) ? fs.realpathSync(integrationPath) : integrationPath;
	const module = await jiti.import(realPath, { default: true });
	const factory = module as IntegrationFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/** Create an Integration object with an empty definitions map. */
function createIntegration(integrationPath: string, resolvedPath: string): Integration {
	const source =
		integrationPath.startsWith("<") && integrationPath.endsWith(">")
			? integrationPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = integrationPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: integrationPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(integrationPath, { source, baseDir }),
		definitions: new Map(),
	};
}

async function loadIntegration(
	integrationPath: string,
	cwd: string,
	runtime: IntegrationRuntime,
): Promise<{ integration: Integration | null; error: string | null }> {
	const resolvedPath = resolvePath(integrationPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadIntegrationModule(resolvedPath);
		if (!factory) {
			return {
				integration: null,
				error: `Integration does not export a valid factory function: ${integrationPath}`,
			};
		}

		const integration = createIntegration(integrationPath, resolvedPath);
		const api = createIntegrationAPI(integration, runtime);
		await factory(api);

		return { integration, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { integration: null, error: `Failed to load integration: ${message}` };
	}
}

/** Create an Integration from an inline factory function (tests / programmatic use). */
export async function loadIntegrationFromFactory(
	factory: IntegrationFactory,
	cwd: string,
	runtime: IntegrationRuntime,
	integrationPath = "<inline>",
): Promise<Integration> {
	const integration = createIntegration(integrationPath, integrationPath);
	const api = createIntegrationAPI(integration, runtime);
	void resolvePath(cwd);
	await factory(api);
	return integration;
}

/** Load integrations from paths. */
export async function loadIntegrations(
	paths: string[],
	cwd: string,
	runtime?: IntegrationRuntime,
): Promise<LoadIntegrationsResult> {
	const integrations: Integration[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const resolvedRuntime = runtime ?? createIntegrationRuntime();

	for (const intPath of paths) {
		const { integration, error } = await loadIntegration(intPath, resolvedCwd, resolvedRuntime);

		if (error) {
			errors.push({ path: intPath, error });
			continue;
		}

		if (integration) {
			integrations.push(integration);
		}
	}

	return {
		integrations,
		errors,
		runtime: resolvedRuntime,
	};
}
