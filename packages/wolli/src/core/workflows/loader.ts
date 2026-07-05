/**
 * Workflow loader. Loads one workflow per file with jiti from the paths the resource
 * loader resolves: the file basename is the workflow name, the default export the
 * definition. Mirrors the integrations loader: one jiti per pass with
 * `moduleCache: true` (backed by the process-global CommonJS cache), so a workflow
 * importing an integration file resolves to the SAME stamped module the integrations
 * loader evaluated. Entry files are evicted from that cache before importing (per-call
 * re-evaluation); a bad file becomes an error entry that never aborts the rest.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../integrations/loader.ts";
import type { LoadWorkflowsResult, Workflow, WorkflowDefinition } from "./types.ts";

const require = createRequire(import.meta.url);

export async function loadWorkflows(paths: string[], cwd: string): Promise<LoadWorkflowsResult> {
	const workflows: Workflow[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		...(isBunBinary || isBundled ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	for (const workflowPath of paths) {
		const resolvedPath = resolvePath(workflowPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		try {
			const canonicalPath = canonicalizePath(resolvedPath);
			// Evict the entry so every load call re-evaluates it; nested modules stay cached
			// (a subtree flush here would wipe the stamped integration modules).
			delete require.cache[canonicalPath];
			const module = await jiti.import(canonicalPath);
			let found = false;
			for (const [name, definition] of Object.entries(module as Record<string, unknown>)) {
				// Structural defineWorkflow-result check: a trigger (`on`) or the callable schema
				// pair (`input`/`output`), plus the run function.
				const shaped =
					typeof definition === "object" &&
					definition !== null &&
					typeof (definition as { run?: unknown }).run === "function" &&
					("on" in definition || ("input" in definition && "output" in definition));
				if (!shaped) continue;
				workflows.push({
					name: name === "default" ? path.basename(resolvedPath, path.extname(resolvedPath)) : name,
					path: workflowPath,
					definition: definition as WorkflowDefinition,
				});
				found = true;
			}
			if (!found) {
				errors.push({
					path: workflowPath,
					error: `Workflow does not export a valid defineWorkflow definition as default: ${workflowPath}`,
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: workflowPath, error: `Failed to load workflow: ${message}` });
		}
	}

	return { workflows, errors };
}
