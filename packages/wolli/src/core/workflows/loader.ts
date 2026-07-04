/**
 * Workflow loader. Loads one workflow per file with jiti from the paths the resource
 * loader resolves: the file basename is the workflow name, the default export the
 * definition. Mirrors the integrations loader: a fresh jiti per file, and a bad file
 * becomes an error entry that never aborts the rest.
 */

import * as path from "node:path";
import { createJiti } from "jiti/static";
import { isBunBinary, isBundled } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getAliases, VIRTUAL_MODULES } from "../extensions/loader.ts";
import type { LoadWorkflowsResult, Workflow, WorkflowDefinition } from "./types.ts";

export async function loadWorkflows(paths: string[], cwd: string): Promise<LoadWorkflowsResult> {
	const workflows: Workflow[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);

	for (const workflowPath of paths) {
		const resolvedPath = resolvePath(workflowPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		try {
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				...(isBunBinary || isBundled
					? { virtualModules: VIRTUAL_MODULES, tryNative: false }
					: { alias: getAliases() }),
			});
			const definition = await jiti.import(canonicalizePath(resolvedPath), { default: true });
			// Structural defineWorkflow-result check: a trigger (`on`) or the callable schema
			// pair (`input`/`output`), plus the run function.
			const shaped =
				typeof definition === "object" &&
				definition !== null &&
				typeof (definition as { run?: unknown }).run === "function" &&
				("on" in definition || ("input" in definition && "output" in definition));
			if (!shaped) {
				errors.push({
					path: workflowPath,
					error: `Workflow does not export a valid defineWorkflow definition as default: ${workflowPath}`,
				});
				continue;
			}
			workflows.push({
				name: path.basename(resolvedPath, path.extname(resolvedPath)),
				path: workflowPath,
				definition: definition as WorkflowDefinition,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: workflowPath, error: `Failed to load workflow: ${message}` });
		}
	}

	return { workflows, errors };
}
