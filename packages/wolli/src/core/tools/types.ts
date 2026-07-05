/**
 * Tool authoring types.
 *
 * One file under the agent home's `tools/` folder defines one tool: the default export
 * is the definition, loaded at startup and merged into every session's tool set,
 * independent of the workflow engine. Forked from the extension `ToolDefinition`
 * (extensions/types.ts) rather than shared: `execute`'s fifth argument is the tool ctx
 * (session facade + integration resolver), not `ExtensionContext`, and the TUI render
 * hooks are gone — a daemon-clean surface. The extension type keeps backing
 * `registerTool` until Phase 5 deletes the extension system.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@opsyhq/agent";
import type { Static, TSchema } from "typebox";
// Type-only: the session facade still lives in the extension system until Phase 5
// relocates it, so the tools subsystem stays additive while both coexist.
import type { Session } from "../extensions/types.ts";
import type { SourceInfo } from "../source-info.ts";
import type { IntegrationHandleOf, IntegrationKey } from "../workflows/types.ts";

/**
 * The runtime surface handed to `execute` as its fifth argument: the facade of the
 * session that made the call, plus the integration resolver (the same signature as
 * `WorkflowContext.integration`) so a packaged tool can call its integration's actions.
 */
export interface ToolContext {
	/** The session facade for the session that made the call. */
	readonly session: Session;
	/** Resolve a configured integration to its flat action handle. The imported definition is the typed key. */
	integration<TActions>(key: IntegrationKey<TActions>): IntegrationHandleOf<TActions>;
}

/** A tool as authored: one `defineTool` default export per file under `tools/`. */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** Tool name — the identifier the model uses in tool calls. */
	name: string;
	/** Human-readable label clients display for the running call. */
	label: string;
	/** The model-facing contract: what the tool does, what it returns, its limits. */
	description: string;
	/** One-line entry in the Available tools section of the default system prompt. */
	promptSnippet?: string;
	/** Guideline bullets appended to the system prompt's Guidelines section while this tool is active. */
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox). Every call's arguments are validated against it before `execute` runs. */
	parameters: TParams;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the session default applies.
	 */
	executionMode?: ToolExecutionMode;
	/** Execute the tool. Throw on failure instead of encoding errors in `content`. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ToolContext,
	): Promise<AgentToolResult<TDetails>>;
}

/** Define a tool. Identity at runtime; preserves the authored parameter/details generics. */
export function defineTool<TParams extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return definition;
}

/** A loaded tool module — mirror of `Integration`/`Workflow`: the definition plus its file identity. */
export interface Tool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
	path: string;
	resolvedPath: string;
}

/** Mirror of `LoadIntegrationsResult`. */
export interface LoadToolsResult {
	tools: Tool[];
	errors: Array<{ path: string; error: string }>;
}
