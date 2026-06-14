/**
 * Tool-rendering types — the subset of `@opsyhq/coding-agent`'s
 * core/extensions/types.ts that the vendored file tools and the tool-execution
 * component depend on.
 *
 * pi's full file wires an entire extension system (event bus, model registry,
 * compaction, slash commands, …) and pulls in a large closure. steward has no
 * extension system, so this keeps only `ToolDefinition` and its render-context
 * types verbatim. `ExtensionContext` is reduced to the single field the tools
 * actually read (`model`, used by read.ts to note non-vision models); the rest
 * of pi's context is irrelevant here. The file lives at the same path pi uses so
 * the copied tool files import `../extensions/types.ts` unchanged.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@opsyhq/agent";
import type { Component } from "@opsyhq/tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/**
 * Context handed to a tool's `execute`. pi's version carries the full extension
 * surface; the vendored tools only read `model`, so that is all this exposes.
 */
export interface ExtensionContext {
	/** The active model, used by tools that tailor output to model capabilities. */
	model?: Model<Api>;
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
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
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
		ctx: ExtensionContext,
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
