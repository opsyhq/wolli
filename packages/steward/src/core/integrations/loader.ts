/**
 * Integration loader. Loads TypeScript integration modules with jiti, discovers
 * them from a per-agent `integrations/` folder, and exposes the definer-side
 * `IntegrationsAPI`. Definitions are written to the integration's `definitions`
 * map directly at load time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti/static";
// Aliased: the zero-arg default falls back to the shared agent dir; callers pass `getAgentDir(name)`.
import { getSharedAgentDir as getAgentDir, isBunBinary } from "../../config.ts";
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

	const module = await jiti.import(integrationPath, { default: true });
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

interface PiManifest {
	integrations?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isIntegrationFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve integration entry points from a directory:
 *  1. package.json with "pi.integrations" → declared paths
 *  2. index.ts / index.js → the index file
 */
function resolveIntegrationEntries(dir: string): string[] | null {
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.integrations?.length) {
			const entries: string[] = [];
			for (const intPath of manifest.integrations) {
				const resolvedIntPath = path.resolve(dir, intPath);
				if (fs.existsSync(resolvedIntPath)) {
					entries.push(resolvedIntPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover integrations in a directory (one level of nesting):
 *  1. Direct files: `integrations/*.ts` or `*.js`
 *  2. Subdir with index: `integrations/* /index.ts` or `index.js`
 *  3. Subdir with package.json declaring "pi.integrations"
 */
function discoverIntegrationsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			if ((entry.isFile() || entry.isSymbolicLink()) && isIntegrationFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const subEntries = resolveIntegrationEntries(entryPath);
				if (subEntries) {
					discovered.push(...subEntries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load integrations from standard locations.
 * Returns `{ integrations, errors, runtime }`.
 */
export async function discoverAndLoadIntegrations(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	runtime?: IntegrationRuntime,
): Promise<LoadIntegrationsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Agent integrations: agentDir/integrations/
	const globalIntDir = path.join(resolvedAgentDir, "integrations");
	addPaths(discoverIntegrationsInDir(globalIntDir));

	// 2. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			const entries = resolveIntegrationEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			addPaths(discoverIntegrationsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadIntegrations(allPaths, resolvedCwd, runtime);
}
