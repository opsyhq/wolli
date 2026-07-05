/**
 * Hooks subsystem: the interception surface. One defineHook file per hook in the agent
 * home's `hooks/` folder; each `before:` hook runs inline in a live turn — fast, never
 * durable, never recorded. The interception sibling of the workflow engine's automation.
 */

export { loadHooks } from "./loader.ts";
export { HookRunner } from "./runner.ts";
export {
	defineHook,
	type Hook,
	type HookContext,
	type HookDefinition,
	type HookError,
	type HookErrorListener,
	type HookEventMap,
	type HookResultMap,
	isToolCallEventType,
} from "./types.ts";
