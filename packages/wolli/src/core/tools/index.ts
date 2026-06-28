export {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindToolDetails,
	type FindToolInput,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsToolDetails,
	type LsToolInput,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolInput,
} from "./write.ts";

import type { AgentTool } from "@opsyhq/agent";
import type { Environment } from "../environments/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition } from "./edit.ts";
import { createFindTool, createFindToolDefinition } from "./find.ts";
import { createGrepTool, createGrepToolDefinition } from "./grep.ts";
import { createLsTool, createLsToolDefinition } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
}

export function createToolDefinition(toolName: ToolName, environment: Environment, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(environment, options?.read);
		case "bash":
			return createBashToolDefinition(environment, options?.bash);
		case "edit":
			return createEditToolDefinition(environment);
		case "write":
			return createWriteToolDefinition(environment);
		case "grep":
			return createGrepToolDefinition(environment);
		case "find":
			return createFindToolDefinition(environment);
		case "ls":
			return createLsToolDefinition(environment);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, environment: Environment, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(environment, options?.read);
		case "bash":
			return createBashTool(environment, options?.bash);
		case "edit":
			return createEditTool(environment);
		case "write":
			return createWriteTool(environment);
		case "grep":
			return createGrepTool(environment);
		case "find":
			return createFindTool(environment);
		case "ls":
			return createLsTool(environment);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(environment: Environment, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(environment, options?.read),
		createBashToolDefinition(environment, options?.bash),
		createEditToolDefinition(environment),
		createWriteToolDefinition(environment),
	];
}

export function createReadOnlyToolDefinitions(environment: Environment, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(environment, options?.read),
		createGrepToolDefinition(environment),
		createFindToolDefinition(environment),
		createLsToolDefinition(environment),
	];
}

export function createAllToolDefinitions(environment: Environment, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(environment, options?.read),
		bash: createBashToolDefinition(environment, options?.bash),
		edit: createEditToolDefinition(environment),
		write: createWriteToolDefinition(environment),
		grep: createGrepToolDefinition(environment),
		find: createFindToolDefinition(environment),
		ls: createLsToolDefinition(environment),
	};
}

export function createCodingTools(environment: Environment, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(environment, options?.read),
		createBashTool(environment, options?.bash),
		createEditTool(environment),
		createWriteTool(environment),
	];
}

export function createReadOnlyTools(environment: Environment, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(environment, options?.read),
		createGrepTool(environment),
		createFindTool(environment),
		createLsTool(environment),
	];
}

export function createAllTools(environment: Environment, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(environment, options?.read),
		bash: createBashTool(environment, options?.bash),
		edit: createEditTool(environment),
		write: createWriteTool(environment),
		grep: createGrepTool(environment),
		find: createFindTool(environment),
		ls: createLsTool(environment),
	};
}
