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
 */

// Type-only imports: the hook event/result interfaces still live in the extension system
// until Phase 5 relocates them; importing types only keeps the hook surface additive while
// both coexist.
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	ContextEvent,
	ContextEventResult,
	ExtensionError,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
	MessageEndEventResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../extensions/types.ts";
import type { DialogUI, WorkflowSession } from "../workflows/types.ts";

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
