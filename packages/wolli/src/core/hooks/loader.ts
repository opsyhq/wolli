/**
 * Hook loader. Loads one hook per file with jiti from the paths the resource loader
 * resolves: the file basename is the hook name, the default export the definition. Mirror of
 * the workflows loader: a fresh jiti per file, and a bad file becomes an error entry that
 * never aborts the rest.
 */

import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../extensions/loader.ts";
import type { Hook, HookDefinition, HookEventMap } from "./types.ts";

export async function loadHooks(
	paths: string[],
	cwd: string,
): Promise<{ hooks: Hook[]; errors: Array<{ path: string; error: string }> }> {
	const hooks: Hook[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);

	for (const hookPath of paths) {
		const resolvedPath = resolvePath(hookPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		try {
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				...(isBunBinary || isBundled
					? { virtualModules: VIRTUAL_MODULES, tryNative: false }
					: { alias: getAliases() }),
			});
			const definition = await jiti.import(canonicalizePath(resolvedPath), { default: true });
			// Structural defineHook-result check: the run function plus a `before:` literal.
			const shaped =
				typeof definition === "object" &&
				definition !== null &&
				typeof (definition as { run?: unknown }).run === "function" &&
				typeof (definition as { before?: unknown }).before === "string";
			if (!shaped) {
				errors.push({
					path: hookPath,
					error: `Hook does not export a valid defineHook definition as default: ${hookPath}`,
				});
				continue;
			}
			hooks.push({
				name: path.basename(resolvedPath, path.extname(resolvedPath)),
				path: hookPath,
				definition: definition as HookDefinition<keyof HookEventMap>,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: hookPath, error: `Failed to load hook: ${message}` });
		}
	}

	return { hooks, errors };
}
