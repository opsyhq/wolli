/**
 * Tools loader. Loads one tool per file with jiti from the paths the resource loader
 * resolves: the default export is the `defineTool` definition. Mirrors the workflows
 * loader: one jiti per pass with `moduleCache: true` (backed by the process-global
 * CommonJS cache), so a tool importing an integration file resolves to the SAME stamped
 * module the integrations loader evaluated. Entry files are evicted from that cache
 * before importing (per-call re-evaluation); a bad file becomes an error entry that
 * never aborts the rest.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../extensions/loader.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { LoadedTool, LoadedToolDefinition, LoadToolsResult } from "./types.ts";

const require = createRequire(import.meta.url);

export async function loadTools(paths: string[], cwd: string): Promise<LoadToolsResult> {
	const tools: LoadedTool[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		...(isBunBinary || isBundled ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	for (const toolPath of paths) {
		const resolvedPath = resolvePath(toolPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		try {
			const canonicalPath = canonicalizePath(resolvedPath);
			// Evict the entry so every load call re-evaluates it; nested modules stay cached
			// (a subtree flush here would wipe the stamped integration modules).
			delete require.cache[canonicalPath];
			const definition = await jiti.import(canonicalPath, { default: true });
			// Structural defineTool-result check: name, parameters schema, execute function.
			const shaped =
				typeof definition === "object" &&
				definition !== null &&
				typeof (definition as { name?: unknown }).name === "string" &&
				typeof (definition as { parameters?: unknown }).parameters === "object" &&
				typeof (definition as { execute?: unknown }).execute === "function";
			if (!shaped) {
				errors.push({ path: toolPath, error: `Tool does not export a defineTool definition: ${toolPath}` });
				continue;
			}
			tools.push({
				definition: definition as LoadedToolDefinition,
				sourceInfo: createSyntheticSourceInfo(toolPath, { source: "local", baseDir: path.dirname(resolvedPath) }),
				path: toolPath,
				resolvedPath,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: toolPath, error: `Failed to load tool: ${message}` });
		}
	}

	return { tools, errors };
}
