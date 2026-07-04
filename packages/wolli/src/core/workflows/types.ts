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

import type { Static, TSchema } from "typebox";
// Type-only imports: the lifecycle event interfaces, session facade, and UI context still
// live in the extension system until Phase 5 relocates them; importing types only keeps
// the workflow subsystem additive while both coexist.
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionError,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	NewSessionOptions,
	Session,
	SessionShutdownEvent,
	SessionStartEvent,
	ThinkingLevelSelectEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensions/types.ts";
import type { IntegrationOnboardUI } from "../integrations/types.ts";
import type { SessionInfo } from "../session.ts";

// ============================================================================
// Triggers
// ============================================================================

/**
 * A typed, inert event descriptor an integration definition exposes (e.g.
 * `telegram.events.message`) and a workflow binds with `on:`. Carries no behavior — just
 * the (service, event) address plus the payload type for handler inference.
 *
 * `service` is stamped by the integrations loader from the file basename, so it must stay
 * writable. `schema` is populated once `defineIntegration` mints descriptors (Phase 2);
 * until then fixtures mint them inline.
 */
export interface IntegrationEventDescriptor<TPayload = unknown> {
	kind: "integration";
	service: string;
	event: string;
	schema?: TSchema;
	/** Phantom payload-type carrier; never present at runtime. */
	readonly _payload?: TPayload;
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
 * A live session as a workflow sees it: the delivery verbs plus the tag surface, and the
 * session id. Steps that produce a session record its id, not the object; the engine
 * rehydrates this handle on access.
 */
export interface WorkflowSession extends Pick<Session, "prompt" | "sendUserMessage" | "getTags" | "setTags"> {
	readonly id: string;
}

/**
 * The four serializable dialog primitives — the one dialog-UI shape, shared with
 * integration onboarding. Present on a workflow ctx only when `ctx.session` exists.
 */
export type DialogUI = IntegrationOnboardUI;

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
	/**
	 * Resolve a configured integration to its flat action handle. The imported definition
	 * is the typed key; `account` defaults to `"default"`.
	 */
	integration<TActions>(key: IntegrationKey<TActions>, account?: string): IntegrationHandleOf<TActions>;
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

/** Mirror of `LoadIntegrationsResult`; workflows have no load-time runtime to carry. */
export interface LoadWorkflowsResult {
	workflows: Workflow[];
	errors: Array<{ path: string; error: string }>;
}

/** Workflow errors reuse the extension error shape so they ride the existing error sink unchanged. */
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
	| { kind: "integration"; service: string; account: string; event: string; payload: unknown }
	| { kind: "lifecycle"; event: keyof AgentEventMap; payload: unknown }
	| { kind: "callable"; input: unknown };

/** Terminal statuses for runs and steps. */
export type RunStatus = "ok" | "error" | "cancelled";

/**
 * Auto steps are recorded by the engine (ctx.agent.* calls, session deliveries,
 * integration actions, nested tool executions); user steps come from ctx.step.
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
	/** Set on nested child steps (e.g. tool executions under a delivery step). */
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
