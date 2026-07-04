/**
 * Integration loader. Loads TypeScript integration modules with jiti from the
 * paths the package manager's `resolve()` surfaces. A module default-exports a
 * `defineIntegration` definition; the loader stamps the service name onto it —
 * the caller-threaded name when the resolver derived one, else the file/dir
 * basename — and carries the authored config on the Integration.
 *
 * One jiti per `loadIntegrations` pass, with `moduleCache: true` — jiti integrates
 * with the process-global CommonJS cache, so a workflow file importing an
 * integration file later resolves to the SAME stamped module. Entry files are
 * evicted from that cache before importing (per-call re-evaluation); nested helper
 * modules are flushed per load generation by the resource loader's reload.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { createJiti, type Jiti } from "jiti/static";
import type { TSchema } from "typebox";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../extensions/loader.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { Integration, IntegrationAction, IntegrationDefinition, LoadIntegrationsResult } from "./types.ts";

const require = createRequire(import.meta.url);

/** The widest definition shape the loader handles — a `defineIntegration` result with any generics erased. */
type LoadedIntegrationDefinition = IntegrationDefinition<
	TSchema,
	Record<string, TSchema>,
	Record<string, IntegrationAction>
>;

/** Fallback service name for an integration path: the file basename, or the package dir for a `<pkg>/index.ts` entry. */
function defaultServiceName(integrationPath: string): string {
	if (integrationPath.startsWith("<") && integrationPath.endsWith(">")) {
		return integrationPath.slice(1, -1).split(":")[0] || "integration";
	}
	const base = path.basename(integrationPath, path.extname(integrationPath));
	return base === "index" ? path.basename(path.dirname(integrationPath)) : base;
}

async function loadIntegrationModule(
	integrationPath: string,
	jiti: Jiti,
): Promise<LoadedIntegrationDefinition | undefined> {
	// Canonicalize exactly like the workflows loader and the reload flush, so all
	// three producers of module-cache keys stay equivalent.
	const canonicalPath = canonicalizePath(integrationPath);
	// Evict the entry so every load call re-evaluates it; nested modules stay cached
	// (a subtree flush here would wipe stamped modules other files already imported).
	delete require.cache[canonicalPath];
	const module = await jiti.import(canonicalPath, { default: true });
	if (
		typeof module === "object" &&
		module !== null &&
		(module as LoadedIntegrationDefinition).kind === "integration"
	) {
		return module as LoadedIntegrationDefinition;
	}
	return undefined;
}

/** Create an Integration carrying its stamped service name and authored config. */
function createIntegration(
	integrationPath: string,
	resolvedPath: string,
	service: string,
	config: Integration["config"],
): Integration {
	const source =
		integrationPath.startsWith("<") && integrationPath.endsWith(">")
			? integrationPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = integrationPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: integrationPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(integrationPath, { source, baseDir }),
		service,
		config,
	};
}

async function loadIntegration(
	integrationPath: string,
	service: string | undefined,
	cwd: string,
	jiti: Jiti,
): Promise<{ integration: Integration | null; error: string | null }> {
	const resolvedPath = resolvePath(integrationPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const definition = await loadIntegrationModule(resolvedPath, jiti);
		if (!definition) {
			return {
				integration: null,
				error: `Integration does not export a defineIntegration definition: ${integrationPath}`,
			};
		}

		const stampedService = service ?? defaultServiceName(integrationPath);
		stampIntegrationDefinition(definition, stampedService);

		const integration = createIntegration(integrationPath, resolvedPath, stampedService, definition.config);
		return { integration, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { integration: null, error: `Failed to load integration: ${message}` };
	}
}

/**
 * Stamp the service name onto a `defineIntegration` definition and every event
 * descriptor, so workflow `on:` bindings resolve.
 */
function stampIntegrationDefinition(definition: LoadedIntegrationDefinition, service: string): void {
	definition.service = service;
	for (const event of Object.keys(definition.events)) {
		definition.events[event].service = service;
	}
}

/** Create an Integration from an inline `defineIntegration` definition (tests / programmatic use). */
export function loadIntegrationFromDefinition<
	TAccount extends TSchema,
	TEvents extends Record<string, TSchema>,
	TActions extends Record<string, IntegrationAction>,
>(definition: IntegrationDefinition<TAccount, TEvents, TActions>, integrationPath = "<inline>"): Integration {
	// Erase the authored generics at this boundary; stamping mutates only `service` fields.
	const loaded = definition as LoadedIntegrationDefinition;
	const service = defaultServiceName(integrationPath);
	stampIntegrationDefinition(loaded, service);
	return createIntegration(integrationPath, integrationPath, service, loaded.config);
}

/**
 * Load integrations. One jiti (and one module-cache view) per pass. An entry may
 * thread a resolver-derived `service` name; a bare path (or absent name) falls back
 * to the basename rule.
 */
export async function loadIntegrations(
	entries: Array<string | { path: string; service?: string }>,
	cwd: string,
): Promise<LoadIntegrationsResult> {
	const integrations: Integration[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		...(isBunBinary || isBundled ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	for (const entry of entries) {
		const intPath = typeof entry === "string" ? entry : entry.path;
		const service = typeof entry === "string" ? undefined : entry.service;
		const { integration, error } = await loadIntegration(intPath, service, resolvedCwd, jiti);

		if (error) {
			errors.push({ path: intPath, error });
			continue;
		}

		if (integration) {
			integrations.push(integration);
		}
	}

	return { integrations, errors };
}
