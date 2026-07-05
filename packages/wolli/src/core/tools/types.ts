/**
 * Tool authoring types.
 *
 * One file under the agent home's `tools/` folder defines one tool: the default export
 * is the definition, loaded at startup and merged into every session's tool set,
 * independent of the workflow engine. `defineTool`/`ToolDefinition` is the authored
 * surface: `execute`'s fifth argument is the tool ctx (session facade + integration
 * resolver), not `ExtensionContext`, and there are no TUI render hooks — a daemon-clean
 * surface.
 *
 * The render-capable `ExtensionToolDefinition` (with `renderCall`/`renderResult` and the
 * `ExtensionContext` execute ctx) that the built-in tool suite types against was re-homed
 * here from the extension system; the extension type keeps backing `registerTool` (via a
 * shim re-export) until Phase 5 deletes the extension system.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@opsyhq/agent";
import type { Component } from "@opsyhq/tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../theme/theme.ts";
import type { SourceInfo } from "../source-info.ts";
import type { DialogUI, IntegrationHandleOf, IntegrationKey, Session, SessionMode } from "../workflows/types.ts";

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

// ============================================================================
// Built-in tool contract (re-homed from the extension system)
// ============================================================================

/**
 * Context handed to every extension event handler, command, shortcut, and custom tool.
 *
 * `session` is the live session this invocation is acting on; `ui`/`mode` are that session's
 * presentation channel — a dialog raised through `ui` routes only to that session's subscribers.
 */
export interface ExtensionContext {
	/** The live session this handler/tool/command is acting on. */
	session: Session;
	/** Dialog primitives for user interaction, scoped to this session. */
	ui: DialogUI;
	/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
	mode: SessionMode;
}

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	showImages: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
}

/**
 * Tool definition for registerTool().
 */
export interface ExtensionToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
	promptSnippet?: string;
	/** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox) */
	parameters: TParams;
	/** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
	renderShell?: "default" | "self";

	/** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;

	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}
