/**
 * Workflow authoring types.
 *
 * A workflow is a typed reaction to an event, or a callable operation, authored as one
 * file under the agent home's `workflows/` folder: one file = one workflow, the filename
 * is the name, the default export the definition. Triggers come in three kinds — an
 * integration event descriptor (`on: telegram.events.message`), an agent lifecycle event
 * literal (`on: "agent_end"`), or none at all (a callable declaring `input`/`output`
 * schemas, invoked by name).
 *
 * Lifecycle handlers are observe-only, permanently; interception is defineHook's job in
 * its own capability folder.
 */

import type { AssistantMessageEvent, ImageContent, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AbortResult, AgentMessage, ThinkingLevel } from "@opsyhq/agent";
import type { Static, TSchema } from "typebox";
import type { IntegrationEventDescriptor } from "../integrations/types.ts";
import type { CustomMessage } from "../messages.ts";
import type { SessionInfo } from "../session.ts";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
// Type-only: `ToolInfo` picks the shape of a tool definition, re-homed alongside the built-in
// tool contract in the tools subsystem.
import type { ExtensionToolDefinition } from "../tools/types.ts";

// ============================================================================
// Session facade + dialog UI (re-homed from the extension system)
// ============================================================================

// `@opsyhq/agent` defines but does not re-export `CompactionResult`, so it is defined
// here, structurally identical to the engine's `harness/compaction/compaction.ts`.
interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/** Run mode the agent is hosted in. Use "tui" to guard terminal-only UI such as custom components. */
export type SessionMode = "tui" | "rpc" | "json" | "print";

/** Source of a `Session.prompt()` submission. */
export type InputSource = "interactive" | "rpc" | "workflow";

/** Options for the session dispatch pipeline (`Session.prompt()`). */
export interface ConversationPromptOptions {
	/** Images to attach to the user turn. An `input` transform may also inject these. */
	images?: ImageContent[];
	/** Where the input came from. Default: `"interactive"`. */
	source?: InputSource;
	/** How to deliver the message while a turn is already streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** When false, skip extension-command + skill/template dispatch (extension-driven sends). Default true. */
	expandPromptTemplates?: boolean;
	/**
	 * Fired once the prompt is accepted (handled, queued, or about to run) with `true`, or
	 * with `false` when it is rejected before any work. Lets a headless caller ack acceptance
	 * without waiting for the whole turn — `prompt()` itself only resolves at turn end.
	 */
	preflightResult?: (success: boolean) => void;
}

/** Options for `Session.newSession()` / `wolli.createSession()`. */
export interface NewSessionOptions {
	/** Initialize the fresh session before it goes live (seed entries, etc.). */
	setup?: (sessionManager: SessionManager) => Promise<void>;
	/** Run against the new session once it is wired and live. */
	withSession?: (session: Session) => Promise<void>;
}

/**
 * A live session — the per-session conversation surface extensions act on. Handed (as `ctx.session`)
 * to every event, command, shortcut, and custom-tool handler, and returned from `wolli.getSession()`.
 *
 * Holds session/harness state plus the actions that operate on a single running conversation. The
 * presentation channel (`ui`/`mode`) is lifted onto `ExtensionContext`, not here; agent-global
 * capabilities (cwd, environments, model registry, integrations, reload, shutdown) live on
 * `ExtensionAPI`.
 */
export interface Session {
	/** Session manager (read-only). */
	readonly sessionManager: ReadonlySessionManager;
	/** Current model (may be undefined). */
	readonly model: Model<any> | undefined;
	/** The current run's abort signal, or undefined when the agent is not streaming. */
	readonly signal: AbortSignal | undefined;

	/** Submit user input through the full command/skill/prompt pipeline, then hand off to the harness. */
	prompt(text: string, options?: ConversationPromptOptions): Promise<void>;

	/** Send a custom message to the conversation. */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	/**
	 * Send a user message to the agent. Always triggers a turn. When the agent is streaming,
	 * use `deliverAs` to specify how to queue the message.
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;

	/** Append a custom entry to the session for state persistence (not sent to the LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/** Whether the agent is idle (not streaming). */
	isIdle(): boolean;
	/** Wait for the agent to finish streaming. */
	waitForIdle(): Promise<void>;
	/** Abort the current agent operation. */
	abort(): Promise<AbortResult>;
	/** Number of queued messages (steer + follow-up + next-turn). */
	getPendingMessageCount(): number;
	/** Whether there are queued messages waiting. */
	hasPendingMessages(): boolean;

	/** Trigger compaction without awaiting completion. */
	compact(options?: CompactOptions): void;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
	/** Get the base system-prompt construction options. */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];
	/** Set the active tools by name. */
	setActiveTools(names: string[]): void;
	/** Get all configured tools with parameter schema, prompt guidelines, and source metadata. */
	getAllTools(): ToolInfo[];
	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];
	/** Re-apply the base + extension tool set (picks up tools registered mid-session). */
	refreshTools(): void;

	/** Set the current model. Returns false if no API key is available. */
	setModel(model: Model<any>): Promise<boolean>;
	/** Resolve a model by `{provider, modelId}` and switch to it. Throws if unknown/unauthenticated. */
	setModelById(provider: string, modelId: string): Promise<Model<any>>;
	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel;
	/** Set thinking level (clamped to model capabilities). */
	setThinkingLevel(level: ThinkingLevel): Promise<void>;

	/** Get the current session name, if set. */
	getSessionName(): string | undefined;
	/** Set the session display name (shown in the session selector). */
	setSessionName(name: string): void;
	/** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
	setLabel(entryId: string, label: string | undefined): void;

	/**
	 * The session's folded tags — a durable, append-only k/v binding an extension owns (e.g. to an
	 * external chat). Core never interprets the keys; query across sessions via `wolli.findSessions`.
	 */
	getTags(): Record<string, string>;
	/** Merge tags into this session (later writes win per key). */
	setTags(tags: Record<string, string>): void;

	/** Start a new session, optionally with initialization. Additive — other sessions stay live. */
	newSession(options?: NewSessionOptions): Promise<{ cancelled: boolean }>;

	/** Reload extensions, skills, prompts, and themes. */
	reload(): Promise<void>;
}

/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
export type ToolInfo = Pick<ExtensionToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	sourceInfo: SourceInfo;
};

/** Options for a dialog UI primitive. */
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
}

/**
 * The narrowed UI surface a dialog caller may use — the dialog primitives only, no chat chrome
 * (editor/widgets/footer/theme). `custom` is excluded: onboarding/hook dialogs are serialized to
 * attached clients, and a component factory can't cross that boundary. Calling anything outside
 * this set is a compile error rather than a silent no-op.
 */
export interface DialogUI {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

// ============================================================================
// Triggers
// ============================================================================

// The descriptor trigger lives with `defineIntegration`, which mints it; re-exported here
// because it is equally the workflow-side `on:` type.
export type { IntegrationEventDescriptor };

// ============================================================================
// Agent lifecycle events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
	type: "session_start";
	/** Why this session start happened. */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	previousSessionFile?: string;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** Destination session file when shutting down due to session replacement. */
	targetSessionFile?: string;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

/**
 * The agent lifecycle events a workflow can bind with `on:`. This is the complete,
 * observe-only set; handlers watch these events and cannot modify them.
 */
export interface AgentEventMap {
	session_start: SessionStartEvent;
	session_shutdown: SessionShutdownEvent;
	agent_start: AgentStartEvent;
	agent_end: AgentEndEvent;
	turn_start: TurnStartEvent;
	turn_end: TurnEndEvent;
	message_start: MessageStartEvent;
	message_update: MessageUpdateEvent;
	message_end: MessageEndEvent;
	tool_execution_start: ToolExecutionStartEvent;
	tool_execution_update: ToolExecutionUpdateEvent;
	tool_execution_end: ToolExecutionEndEvent;
	model_select: ModelSelectEvent;
	thinking_level_select: ThinkingLevelSelectEvent;
}

// ============================================================================
// Integration access (ctx.integration)
// ============================================================================

/**
 * The structural key protocol `ctx.integration` accepts: any object carrying the
 * loader-stamped `service` name. `defineIntegration` definitions satisfy it; the phantom
 * `_actions` record (action name to call signature) types the returned handle.
 */
export interface IntegrationKey<TActions> {
	readonly service: string;
	/** Phantom action-signature carrier; never present at runtime. */
	readonly _actions?: TActions;
}

/**
 * The flat, typed action handle `ctx.integration(def)` returns: one async function per
 * action (`await tg.sendMessage({ ... })`), parameters validated on every call.
 */
export type IntegrationHandleOf<TActions> = {
	[K in keyof TActions]: TActions[K] extends (params: infer P) => infer R ? (params: P) => Promise<Awaited<R>> : never;
};

// ============================================================================
// Workflow ctx
// ============================================================================

/**
 * A live session as a workflow sees it: the delivery verbs, the tag surface, the session
 * id, and the read-only name/model a router surfaces (e.g. a `/status` command). Steps
 * that produce a session record its id, not the object; the engine rehydrates this handle
 * on access.
 */
export interface WorkflowSession
	extends Pick<Session, "prompt" | "sendUserMessage" | "getTags" | "setTags" | "getSessionName" | "model"> {
	readonly id: string;
}

/** The this-agent surface on `ctx.agent`. Every call is recorded as a step of the run. */
export interface WorkflowAgent {
	/** Stored sessions whose folded tags subset-match `filter`, newest first. */
	findSessions(filter: Record<string, string>): Promise<SessionInfo[]>;
	/** Rehydrate a stored session by id. */
	openSession(id: string): Promise<WorkflowSession>;
	/** Start a fresh session; `setup` initializes it (e.g. appendTags) before it goes live. */
	createSession(options?: Pick<NewSessionOptions, "setup">): Promise<WorkflowSession>;
	/** Stored sessions for this agent (newest first). */
	listSessions(): Promise<SessionInfo[]>;
	/** The agent home path. */
	readonly cwd: string;
}

/** Context scoped to one run. Everything the handler does through it is recorded as steps. */
export interface WorkflowContext {
	/** The this-agent surface. */
	readonly agent: WorkflowAgent;
	/** Resolve a configured integration to its flat action handle. The imported definition is the typed key. */
	integration<TActions>(key: IntegrationKey<TActions>): IntegrationHandleOf<TActions>;
	/** Wrap inline logic in a named, recorded step. Return values must be serializable. */
	step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
	/** The run's abort signal; pass it to anything long-running. */
	readonly signal: AbortSignal;
}

/**
 * Context for lifecycle-triggered runs: additionally carries the producing session and
 * its dialog UI. Integration-event and callable runs have no producing session, so they
 * get the base `WorkflowContext` — headless, no `session`, no `ui`.
 */
export interface LifecycleWorkflowContext extends WorkflowContext {
	/** The producing session. */
	readonly session: WorkflowSession;
	/** Dialog primitives routed to the producing session's clients. */
	readonly ui: DialogUI;
}

// ============================================================================
// defineWorkflow
// ============================================================================

/** A workflow bound to an integration event descriptor. */
export interface IntegrationWorkflowDefinition<TPayload> {
	on: IntegrationEventDescriptor<TPayload>;
	run(event: TPayload, ctx: WorkflowContext): void | Promise<void>;
}

/** A workflow bound to an agent lifecycle event. Observe-only: the handler returns void. */
export interface LifecycleWorkflowDefinition<TEvent extends keyof AgentEventMap> {
	on: TEvent;
	run(event: AgentEventMap[TEvent], ctx: LifecycleWorkflowContext): void | Promise<void>;
}

/**
 * A callable workflow: no trigger. Invoked by name with an input validated against
 * `input`; the return value is validated against `output` and flows back to the caller.
 */
export interface CallableWorkflowDefinition<TInput extends TSchema, TOutput extends TSchema> {
	input: TInput;
	output: TOutput;
	run(input: Static<TInput>, ctx: WorkflowContext): Static<TOutput> | Promise<Static<TOutput>>;
}

/** Any workflow definition — the loader/runner-facing union. */
export type WorkflowDefinition =
	| IntegrationWorkflowDefinition<unknown>
	| LifecycleWorkflowDefinition<keyof AgentEventMap>
	| CallableWorkflowDefinition<TSchema, TSchema>;

/**
 * Define a workflow. Identity at runtime; the overloads preserve trigger-specific typing
 * (integration payload, lifecycle event shape, callable input/output).
 */
export function defineWorkflow<TPayload>(
	definition: IntegrationWorkflowDefinition<TPayload>,
): IntegrationWorkflowDefinition<TPayload>;
export function defineWorkflow<TEvent extends keyof AgentEventMap>(
	definition: LifecycleWorkflowDefinition<TEvent>,
): LifecycleWorkflowDefinition<TEvent>;
export function defineWorkflow<TInput extends TSchema, TOutput extends TSchema>(
	definition: CallableWorkflowDefinition<TInput, TOutput>,
): CallableWorkflowDefinition<TInput, TOutput>;
export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
	return definition;
}

/**
 * The agent lifecycle surface: `wolli.on("agent_end", run)` authors a lifecycle workflow the
 * same way `defineWorkflow({ on: "agent_end", run })` does, but reads as binding to the agent.
 */
export interface WolliApi {
	on<TEvent extends keyof AgentEventMap>(
		event: TEvent,
		run: LifecycleWorkflowDefinition<TEvent>["run"],
	): LifecycleWorkflowDefinition<TEvent>;
}

/** The agent lifecycle surface; import it in a `workflows/` file to bind lifecycle events. */
export const wolli: WolliApi = {
	on: (event, run) => defineWorkflow({ on: event, run }),
};

/** Trigger kind of a workflow definition. */
export type WorkflowKind = "integration" | "lifecycle" | "callable";

/** Runtime discriminator for a definition's trigger kind. Internal to core/workflows. */
export function getWorkflowKind(def: WorkflowDefinition): WorkflowKind {
	if ("on" in def) return typeof def.on === "string" ? "lifecycle" : "integration";
	return "callable";
}

// ============================================================================
// Loaded workflows and the error sink
// ============================================================================

/** A loaded workflow module — mirror of `Extension`/`Integration`: the definition plus its file identity. */
export interface Workflow {
	/** Workflow name — the file basename. */
	name: string;
	/** Source path, for error reporting. */
	path: string;
	definition: WorkflowDefinition;
}

/** Mirror of `LoadIntegrationsResult`. */
export interface LoadWorkflowsResult {
	workflows: Workflow[];
	errors: Array<{ path: string; error: string }>;
}

/** The shape carried on the load/runtime error sink shared by workflows, hooks, and integrations. */
export interface ExtensionError {
	path: string;
	event: string;
	error: string;
	stack?: string;
}

/** Workflow errors reuse the shared error shape so they ride the existing error sink unchanged. */
export type WorkflowError = ExtensionError;

export type WorkflowErrorListener = (error: WorkflowError) => void;

// ============================================================================
// Runs and steps (the record shape is the durability groundwork)
// ============================================================================

/**
 * What fired a run. The payload is serialized in full on run_start — a future engine
 * must be able to re-drive the handler from this record; identity summaries apply to
 * step results only.
 */
export type RunTrigger =
	| { kind: "integration"; service: string; event: string; payload: unknown }
	| { kind: "lifecycle"; event: keyof AgentEventMap; payload: unknown }
	| { kind: "callable"; input: unknown };

/** Terminal statuses for runs and steps. */
export type RunStatus = "ok" | "error" | "cancelled";

/**
 * Auto steps are recorded by the engine (ctx.agent.* calls, session deliveries,
 * integration actions); user steps come from ctx.step.
 */
export type StepKind = "auto" | "user";

/** Serialized error shape on step_end/run_end records. */
export interface RecordedError {
	name: string;
	message: string;
	stack?: string;
}

/** Opens a run: one per trigger firing. */
export interface RunStartRecord {
	type: "run_start";
	/** UUIDv7 — time-sortable, and doubles as the runs/ debug-log filename. */
	runId: string;
	/** Workflow name (the file basename). */
	workflow: string;
	trigger: RunTrigger;
	/** Load-generation stamp: which generation of loaded code produced this run. */
	generation: number;
	/** Present when another run's step provoked this run (workflow-triggers-workflow chains). */
	parentRunId?: string;
	causeStepId?: number;
	ts: number;
}

/**
 * Opens a step. `stepId` is sequential within the run and exists for ordering and
 * parentage; `checkpointKey` is the future replay key.
 */
export interface StepStartRecord {
	type: "step_start";
	stepId: number;
	/** Reserved for nested child steps; nothing records children in v1. */
	parentStepId?: number;
	/**
	 * Step name plus per-name occurrence counter ("name", "name#2", ...). Top-level steps
	 * only: children are observational, never checkpoint candidates, and do not feed the
	 * counters (a skipped parent must not shift sibling keys).
	 */
	checkpointKey?: string;
	name: string;
	kind: StepKind;
	args?: unknown;
	ts: number;
}

/** Closes a step. Only ok results are checkpoint material for a future engine. */
export interface StepEndRecord {
	type: "step_end";
	stepId: number;
	status: RunStatus;
	result?: unknown;
	error?: RecordedError;
	/** Reserved for a future retrying engine; constant 1 in v1. */
	attempt: number;
	ts: number;
}

/** Closes the run. */
export interface RunEndRecord {
	type: "run_end";
	status: RunStatus;
	error?: RecordedError;
	ts: number;
}

/** One line of a run's record stream. Append-only; records are never rewritten. */
export type RunRecord = RunStartRecord | StepStartRecord | StepEndRecord | RunEndRecord;
