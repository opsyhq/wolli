/**
 * Hook authoring types.
 *
 * A hook is the interception surface: the only agent-home code that can alter engine
 * behavior, authored as one file under the agent home's `hooks/` folder — one file = one
 * hook, the filename is the name, the default export the definition. Where lifecycle `on:`
 * handlers observe, `before:` hooks decide — block a tool call, rewrite input, replace a
 * provider payload.
 *
 * Hooks run inline in a live turn: fast, never durable, never recorded. The workflow engine
 * is for automation; hooks are its interception sibling. Hooks cannot bind `on:`, are not
 * callable, and have no input/output schemas.
 *
 * This module also owns the `before:` event/result interfaces (re-homed from the extension
 * system): they carry today's extension event shapes unchanged, old `type` discriminants
 * included.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage, CompactionPreparation } from "@opsyhq/agent";
import type { CustomMessage } from "../messages.ts";
import type { SessionEntry } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";
import type { DialogUI, ExtensionError, InputSource, MessageEndEvent, WorkflowSession } from "../workflows/types.ts";

// `@opsyhq/agent` defines but does not re-export `CompactionResult`, so it is defined
// here, structurally identical to the engine's `harness/compaction/compaction.ts`.
interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

// ============================================================================
// Agent Events
// ============================================================================

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** The raw user prompt text (after expansion). */
	prompt: string;
	/** Images attached to the user prompt, if any. */
	images?: ImageContent[];
	/** The fully assembled system prompt string. */
	systemPrompt: string;
	/** Structured options used to build the system prompt. Extensions can inspect this to understand what wolli loaded without re-discovering resources. */
	systemPromptOptions: BuildSystemPromptOptions;
}

// ============================================================================
// Input Events
// ============================================================================

/** Fired when user input is received, before agent processing */
export interface InputEvent {
	type: "input";
	/** The input text */
	text: string;
	/** Attached images, if any */
	images?: ImageContent[];
	/** Where the input came from */
	source: InputSource;
	/** How the input will be delivered during streaming, or undefined when idle */
	streamingBehavior?: "steer" | "followUp";
}

/** Result from input event handler */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// Type guards for ToolResultEvent
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

// ============================================================================
// Hook authoring surface
// ============================================================================

/**
 * The events a hook binds with `before:` — the interception counterpart to the observe-only
 * `AgentEventMap`. The values are today's extension event interfaces unchanged, old `type`
 * discriminants included (a `before: "agent_start"` handler receives a `before_agent_start`
 * event).
 */
export interface HookEventMap {
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
	input: InputEvent;
	context: ContextEvent;
	provider_request: BeforeProviderRequestEvent;
	agent_start: BeforeAgentStartEvent;
	compact: SessionBeforeCompactEvent;
	message_end: MessageEndEvent;
}

/**
 * Runtime mirror of `keyof HookEventMap`, for the loader's `before:` check. Hook files are
 * jiti-loaded scripts, so the type-level event set cannot reject a typo'd or stale literal —
 * and an interception hook that silently never fires is the worst failure mode. The
 * `satisfies` record keeps the set complete and member-checked against the map.
 */
export const HOOK_EVENTS: ReadonlySet<string> = new Set(
	Object.keys({
		tool_call: true,
		tool_result: true,
		input: true,
		context: true,
		provider_request: true,
		agent_start: true,
		compact: true,
		message_end: true,
	} satisfies Record<keyof HookEventMap, true>),
);

/** What a handler may return per event to intercept it — today's extension result shapes, unchanged. */
export interface HookResultMap {
	tool_call: ToolCallEventResult;
	tool_result: ToolResultEventResult;
	input: InputEventResult;
	context: ContextEventResult;
	provider_request: BeforeProviderRequestEventResult;
	agent_start: BeforeAgentStartEventResult;
	compact: SessionBeforeCompactResult;
	message_end: MessageEndEventResult;
}

/**
 * The context handed to a hook: the producing session's delivery/tag surface plus its dialog
 * primitives. Every hook event is session-scoped, so `ctx.session` is always present.
 */
export interface HookContext {
	/** The producing session. */
	readonly session: WorkflowSession;
	/** Dialog primitives routed to the producing session's clients. */
	readonly ui: DialogUI;
}

/**
 * A hook: one `before:` event plus a handler that may intercept it. Returning nothing
 * means no interception.
 */
export interface HookDefinition<TEvent extends keyof HookEventMap> {
	before: TEvent;
	run(
		event: HookEventMap[TEvent],
		ctx: HookContext,
		// biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would reject run() impls without a return statement
	): HookResultMap[TEvent] | void | Promise<HookResultMap[TEvent] | void>;
}

/**
 * Define a hook. Identity at runtime; the generic preserves the event literal so the
 * handler's event and result shapes narrow.
 */
export function defineHook<TEvent extends keyof HookEventMap>(
	definition: HookDefinition<TEvent>,
): HookDefinition<TEvent> {
	return definition;
}

/** A loaded hook module — mirror of `Workflow`: the definition plus its file identity. */
export interface Hook {
	/** Hook name — the file basename. */
	name: string;
	/** Source path, for error reporting. */
	path: string;
	definition: HookDefinition<keyof HookEventMap>;
}

/** Hook errors reuse the extension error shape so they ride the existing error sink unchanged. */
export type HookError = ExtensionError;

export type HookErrorListener = (error: HookError) => void;
