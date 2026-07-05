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

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Static imports of packages that agent-home files may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to loaded modules.
import * as _bundledPiAi from "@earendil-works/pi-ai";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiAgentCore from "@opsyhq/agent";
import * as _bundledPiTui from "@opsyhq/tui";
import { createJiti, type Jiti } from "jiti/static";
import type { TSchema } from "typebox";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { isBunBinary, isBundled } from "../../config.ts";
// This namespace import does not close a value cycle: `getAliases`/`VIRTUAL_MODULES` stay off the
// index.ts barrel and the reference is read lazily (when jiti is created), by which point index.ts
// has finished initializing. Agent-home files import their host from @opsyhq/wolli / bare "wolli".
import * as _bundledPiCodingAgent from "../../index.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { Integration, IntegrationAction, IntegrationDefinition, LoadIntegrationsResult } from "./types.ts";

const require = createRequire(import.meta.url);

/** Modules available to agent-home loaders via virtualModules — for the compiled Bun binary. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@opsyhq/agent": _bundledPiAgentCore,
	"@opsyhq/tui": _bundledPiTui,
	"@earendil-works/pi-ai": _bundledPiAi,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	// The host-package identity string is wolli's own package name.
	"@opsyhq/wolli": _bundledPiCodingAgent,
	// The bare authoring specifier: workflow files `import { defineWorkflow } from "wolli"`.
	wolli: _bundledPiCodingAgent,
	// NOTE: integration-specific deps (e.g. grammy) are NOT bundled here. A
	// self-contained integration package brings its own node_modules, and jiti
	// resolves the integration's own copy. (If a future Bun binary build cannot
	// resolve an integration's own node_modules, re-add the dep here + keep it a
	// devDependency so the binary ships a bundled fallback — see plan Risk.)
};

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

export function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	// Running from source (dev/Vitest), the compiled index.js beside this file's parent
	// does not exist; value imports from "wolli"/"@opsyhq/wolli" must land on index.ts.
	const compiledPackageIndex = path.resolve(__dirname, "../..", "index.js");
	const packageIndex = fs.existsSync(compiledPackageIndex)
		? compiledPackageIndex
		: path.resolve(__dirname, "../..", "index.ts");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string | null => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		// Real Node.js ESM exposes import.meta.resolve.
		if (typeof import.meta.resolve === "function") {
			return fileURLToPath(import.meta.resolve(specifier));
		}
		// Fallback for environments without import.meta.resolve (e.g. Vitest SSR):
		// best-effort CJS resolution; omit the alias entirely if even that fails.
		try {
			return require.resolve(specifier);
		} catch {
			return null;
		}
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@opsyhq/agent");
	// Required by the from-source "wolli" entry: src/core/session.ts imports the /node
	// subpath, and jiti prefix-appends onto the bare "@opsyhq/agent" alias without it.
	const piAgentCoreNodeEntry = resolveWorkspaceOrImport("agent/dist/node.js", "@opsyhq/agent/node");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@opsyhq/tui");
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");

	_aliases = {
		// The host-package identity string is wolli's own package name.
		"@opsyhq/wolli": piCodingAgentEntry,
		// The bare authoring specifier: workflow files `import { defineWorkflow } from "wolli"`.
		wolli: piCodingAgentEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
		// Integration deps (e.g. grammy) are intentionally NOT aliased here: jiti
		// resolves an installed integration's OWN node_modules copy.
	};
	// Only alias entries that resolved. In the real runtime all of these resolve; under
	// Vitest SSR (no import.meta.resolve) the bundled library entries may be omitted and
	// fall back to the host module resolver.
	if (piAgentCoreEntry) _aliases["@opsyhq/agent"] = piAgentCoreEntry;
	if (piAgentCoreNodeEntry) _aliases["@opsyhq/agent/node"] = piAgentCoreNodeEntry;
	if (piTuiEntry) _aliases["@opsyhq/tui"] = piTuiEntry;
	if (piAiEntry) _aliases["@earendil-works/pi-ai"] = piAiEntry;
	if (piAiOauthEntry) _aliases["@earendil-works/pi-ai/oauth"] = piAiOauthEntry;

	return _aliases;
}

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
