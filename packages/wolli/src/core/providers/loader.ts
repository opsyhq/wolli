/**
 * Providers loader. Loads one provider per file with jiti from the paths the resource loader
 * resolves: the default export is the `defineProvider` config. Mirrors the tools
 * loader: one jiti per pass with `moduleCache: true` (backed by the process-global
 * CommonJS cache), so a provider importing an integration file resolves to the SAME stamped
 * module the integrations loader evaluated. Entry files are evicted from that cache
 * before importing (per-call re-evaluation); a bad file becomes an error entry that
 * never aborts the rest.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../integrations/loader.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { LoadProvidersResult, Provider, ProviderConfig } from "./types.ts";

const require = createRequire(import.meta.url);

export async function loadProviders(paths: string[], cwd: string): Promise<LoadProvidersResult> {
	const providers: Provider[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		...(isBunBinary || isBundled ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	for (const providerPath of paths) {
		const resolvedPath = resolvePath(providerPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		try {
			const canonicalPath = canonicalizePath(resolvedPath);
			// Evict the entry so every load call re-evaluates it; nested modules stay cached
			// (a subtree flush here would wipe the stamped integration modules).
			delete require.cache[canonicalPath];
			const definition = await jiti.import(canonicalPath, { default: true });
			// Structural defineProvider-result check: a non-null object (a ProviderConfig).
			const shaped = typeof definition === "object" && definition !== null;
			if (!shaped) {
				errors.push({
					path: providerPath,
					error: `Provider does not export a defineProvider config: ${providerPath}`,
				});
				continue;
			}
			providers.push({
				name: path.basename(providerPath, path.extname(providerPath)),
				config: definition as ProviderConfig,
				sourceInfo: createSyntheticSourceInfo(providerPath, {
					source: "local",
					baseDir: path.dirname(resolvedPath),
				}),
				path: providerPath,
				resolvedPath,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: providerPath, error: `Failed to load provider: ${message}` });
		}
	}

	return { providers, errors };
}
