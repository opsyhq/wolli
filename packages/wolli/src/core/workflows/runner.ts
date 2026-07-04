/**
 * Workflow runner: indexes loaded workflows by trigger and executes their runs.
 *
 * One runner per load generation; the runtime swaps it on reload. Every trigger firing
 * becomes one recorded run — the runner opens a RunJournal, builds the ctx whose calls
 * (ctx.agent.*, integration actions, session deliveries, ctx.step) all land in it as
 * steps, and runs the handler under a per-run AbortController. A failed handler ends its
 * run as `error` and surfaces on the error sink, never back into the dispatching event
 * path. Callables are the exception: `invoke` has a waiting caller, so it validates
 * input/output against the declared schemas and rethrows failures.
 *
 * Hooks ride the same engine as recorded interception runs: each `before:` hook firing is
 * its own run with the lifecycle ctx (every hook event is session-scoped), and the eight
 * `dispatch*` methods (translated from ExtensionRunner's emit-family) thread the event
 * through the bound hooks in load order, short-circuiting on terminal decisions.
 * Interception is the one place a run's outcome flows back to the caller, but never as a
 * throw: a failed hook fails open — its run records the error, the error surfaces on the
 * sink, and the chain continues.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@opsyhq/agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BuildSystemPromptOptions,
	ContextEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	MessageEndEvent,
	NewSessionOptions,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../extensions/types.ts";
import type { IntegrationRunner } from "../integrations/runner.ts";
import type { SessionInfo } from "../session.ts";
import type { Hook, HookEventMap, HookResultMap } from "./hooks.ts";
import { RunJournal } from "./journal.ts";
import type {
	AgentEventMap,
	CallableWorkflowDefinition,
	DialogUI,
	IntegrationHandleOf,
	IntegrationKey,
	IntegrationWorkflowDefinition,
	LifecycleWorkflowContext,
	LifecycleWorkflowDefinition,
	RunStatus,
	RunTrigger,
	Workflow,
	WorkflowAgent,
	WorkflowContext,
	WorkflowError,
	WorkflowErrorListener,
	WorkflowSession,
} from "./types.ts";

type Validator = ReturnType<typeof Compile>;

/**
 * The this-agent operations the runtime supplies. Sessions come back as the plain
 * workflow-session surface; the runner wraps them so deliveries record as steps.
 */
export interface WorkflowAgentBackend {
	/** The agent home path. */
	readonly cwd: string;
	findSessions(filter: Record<string, string>): Promise<SessionInfo[]>;
	listSessions(): Promise<SessionInfo[]>;
	openSession(id: string): Promise<WorkflowSession>;
	createSession(options?: Pick<NewSessionOptions, "setup">): Promise<WorkflowSession>;
}

export interface WorkflowRunnerOptions {
	backend: WorkflowAgentBackend;
	/** The same-generation integration runner; `ctx.integration` resolves actions on it. */
	integrations: IntegrationRunner;
	/** Load-generation stamp for run records. */
	generation: number;
	/** When set, every run mirrors its records to <runsDir>/<runId>.jsonl. */
	runsDir?: string;
}

interface IntegrationBinding {
	workflow: Workflow;
	definition: IntegrationWorkflowDefinition<unknown>;
}

interface LifecycleBinding {
	workflow: Workflow;
	definition: LifecycleWorkflowDefinition<keyof AgentEventMap>;
}

interface CallableEntry {
	workflow: Workflow;
	definition: CallableWorkflowDefinition<TSchema, TSchema>;
	inputValidator: Validator;
	outputValidator: Validator;
}

/** Terminal outcome of one run, for the code path that provoked it. */
interface RunOutcome {
	status: RunStatus;
	result?: unknown;
	error?: unknown;
}

/** The accumulated contribution of the `agent_start` hook chain: injected messages, a rewritten system prompt. */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

export class WorkflowRunner {
	private readonly backend: WorkflowAgentBackend;
	private readonly integrations: IntegrationRunner;
	private readonly generation: number;
	private readonly runsDir: string | undefined;

	/** `service event` → workflows bound to that integration event. */
	private readonly integrationTriggers = new Map<string, IntegrationBinding[]>();
	/** Lifecycle event literal → workflows bound to it. */
	private readonly lifecycleTriggers = new Map<string, LifecycleBinding[]>();
	/** Workflow name → callable with its precompiled schema validators. */
	private readonly callables = new Map<string, CallableEntry>();
	/** `before:` event → hooks bound to it, in load order — the interception chain. */
	private readonly hooks = new Map<keyof HookEventMap, Hook[]>();

	private readonly journals: RunJournal[] = [];
	/** Controllers of in-flight runs; `stop()` fires them. */
	private readonly activeRuns = new Set<AbortController>();
	private readonly errorListeners = new Set<WorkflowErrorListener>();

	constructor(workflows: Workflow[], hooks: Hook[], options: WorkflowRunnerOptions) {
		this.backend = options.backend;
		this.integrations = options.integrations;
		this.generation = options.generation;
		this.runsDir = options.runsDir;

		for (const hook of hooks) {
			const bindings = this.hooks.get(hook.definition.before);
			if (bindings) bindings.push(hook);
			else this.hooks.set(hook.definition.before, [hook]);
		}

		for (const workflow of workflows) {
			const definition = workflow.definition;
			if (!("on" in definition)) {
				if (this.callables.has(workflow.name)) continue; // first registration wins
				this.callables.set(workflow.name, {
					workflow,
					definition,
					inputValidator: Compile(definition.input),
					outputValidator: Compile(definition.output),
				});
			} else if (typeof definition.on === "string") {
				const bindings = this.lifecycleTriggers.get(definition.on);
				if (bindings) bindings.push({ workflow, definition });
				else this.lifecycleTriggers.set(definition.on, [{ workflow, definition }]);
			} else {
				const key = this.triggerKey(definition.on.service, definition.on.event);
				const bindings = this.integrationTriggers.get(key);
				if (bindings) bindings.push({ workflow, definition });
				else this.integrationTriggers.set(key, [{ workflow, definition }]);
			}
		}
	}

	/** Journals of every run this runner has executed, in start order — the observability seam. */
	get runs(): readonly RunJournal[] {
		return this.journals;
	}

	onError(listener: WorkflowErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/**
	 * Fire every workflow bound to (service, event) — the seam the IntegrationRunner wires
	 * into in Phase 2, which emits per (service, account). Runs execute inline and
	 * sequentially; a failed run surfaces on the error sink and never throws back into the
	 * emitting producer.
	 */
	async dispatchIntegrationEvent(service: string, account: string, event: string, payload: unknown): Promise<void> {
		const bindings = this.integrationTriggers.get(this.triggerKey(service, event));
		if (!bindings) return;
		const trigger: RunTrigger = { kind: "integration", service, account, event, payload };
		for (const { workflow, definition } of bindings) {
			await this.dispatchRun(workflow, trigger, `${service}.${event}`, (journal, signal) =>
				definition.run(payload, this.createContext(journal, signal)),
			);
		}
	}

	/**
	 * Fire every workflow bound to the lifecycle event `event.type`, with the gated
	 * lifecycle ctx: the base ctx plus `ctx.session` (the producing session, deliveries
	 * recorded as steps) and `ctx.ui` (its dialog primitives, routed to that session's
	 * clients). Runs execute inline and sequentially; a failed run surfaces on the error
	 * sink and never throws back into the emitting event path.
	 */
	async dispatchLifecycle(
		event: AgentEventMap[keyof AgentEventMap],
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<void> {
		const bindings = this.lifecycleTriggers.get(event.type);
		if (!bindings) return;
		const trigger: RunTrigger = { kind: "lifecycle", event: event.type, payload: event };
		for (const { workflow, definition } of bindings) {
			await this.dispatchRun(workflow, trigger, event.type, (journal, signal) =>
				definition.run(event, this.createLifecycleContext(journal, signal, session, ui)),
			);
		}
	}

	/** Whether any workflow is bound to this lifecycle event — lets the runtime skip binding work. */
	hasTriggers(type: string): boolean {
		return this.lifecycleTriggers.has(type);
	}

	/** Whether any hook binds this `before:` event — lets the runtime skip building the event and dispatching. */
	hasHooks(event: string): boolean {
		return this.hooks.has(event as keyof HookEventMap);
	}

	/**
	 * The `tool_call` chain (translated from ExtensionRunner.emitToolCall): the SAME event
	 * object flows to every hook — `event.input` mutates in place, so a later hook sees
	 * earlier patches (today's documented contract). A `{ block }` result short-circuits;
	 * otherwise the last truthy result wins.
	 */
	async dispatchToolCall(
		event: ToolCallEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<ToolCallEventResult | undefined> {
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks.get("tool_call") ?? []) {
			const handlerResult = await this.dispatchHook(hook, "tool_call", event, session, ui);

			if (handlerResult) {
				result = handlerResult;
				if (result.block) {
					return result;
				}
			}
		}

		return result;
	}

	/** The `tool_result` chain (translated from ExtensionRunner.emitToolResult): one working copy patched across hooks. */
	async dispatchToolResult(
		event: ToolResultEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<ToolResultEventResult | undefined> {
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const hook of this.hooks.get("tool_result") ?? []) {
			const handlerResult = await this.dispatchHook(hook, "tool_result", currentEvent, session, ui);
			if (!handlerResult) continue;

			if (handlerResult.content !== undefined) {
				currentEvent.content = handlerResult.content;
				modified = true;
			}
			if (handlerResult.details !== undefined) {
				currentEvent.details = handlerResult.details;
				modified = true;
			}
			if (handlerResult.isError !== undefined) {
				currentEvent.isError = handlerResult.isError;
				modified = true;
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	/** The `message_end` chain (translated from ExtensionRunner.emitMessageEnd): a role-changing replacement is rejected. */
	async dispatchMessageEnd(
		event: MessageEndEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<AgentMessage | undefined> {
		let currentMessage = event.message;
		let modified = false;

		for (const hook of this.hooks.get("message_end") ?? []) {
			const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
			const handlerResult = await this.dispatchHook(hook, "message_end", currentEvent, session, ui);
			if (!handlerResult?.message) continue;

			if (handlerResult.message.role !== currentMessage.role) {
				this.emitError({
					path: hook.path,
					event: "message_end",
					error: "message_end hooks must return a message with the same role",
				});
				continue;
			}

			currentMessage = handlerResult.message;
			modified = true;
		}

		return modified ? currentMessage : undefined;
	}

	/** The `context` chain (translated from ExtensionRunner.emitContext): messages cloned once, replaced per hook. */
	async dispatchContext(messages: AgentMessage[], session: WorkflowSession, ui: DialogUI): Promise<AgentMessage[]> {
		let currentMessages = structuredClone(messages);

		for (const hook of this.hooks.get("context") ?? []) {
			const event: ContextEvent = { type: "context", messages: currentMessages };
			const handlerResult = await this.dispatchHook(hook, "context", event, session, ui);

			if (handlerResult?.messages) {
				currentMessages = handlerResult.messages;
			}
		}

		return currentMessages;
	}

	/** The `provider_request` chain (translated from ExtensionRunner.emitBeforeProviderRequest): payload threaded, any non-undefined return replaces it. */
	async dispatchProviderRequest(payload: unknown, session: WorkflowSession, ui: DialogUI): Promise<unknown> {
		let currentPayload = payload;

		for (const hook of this.hooks.get("provider_request") ?? []) {
			const event: BeforeProviderRequestEvent = {
				type: "before_provider_request",
				payload: currentPayload,
			};
			const handlerResult = await this.dispatchHook(hook, "provider_request", event, session, ui);
			if (handlerResult !== undefined) {
				currentPayload = handlerResult;
			}
		}

		return currentPayload;
	}

	/**
	 * The `agent_start` chain (translated from ExtensionRunner.emitBeforeAgentStart):
	 * messages accumulate, the system prompt chains (last writer wins). systemPromptOptions
	 * arrives explicitly — the workflow session facade does not expose it the way the
	 * extension ctx.session does.
	 */
	async dispatchAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		let currentSystemPrompt = systemPrompt;
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const hook of this.hooks.get("agent_start") ?? []) {
			const event: BeforeAgentStartEvent = {
				type: "before_agent_start",
				prompt,
				images,
				systemPrompt: currentSystemPrompt,
				systemPromptOptions,
			};
			const handlerResult = await this.dispatchHook(hook, "agent_start", event, session, ui);

			if (handlerResult) {
				const result = handlerResult;
				if (result.message) {
					messages.push(result.message);
				}
				if (result.systemPrompt !== undefined) {
					currentSystemPrompt = result.systemPrompt;
					systemPromptModified = true;
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	/**
	 * The `input` chain (translated from ExtensionRunner.emitInput): transforms chain,
	 * "handled" short-circuits.
	 */
	async dispatchInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior: "steer" | "followUp" | undefined,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<InputEventResult> {
		let currentText = text;
		let currentImages = images;

		for (const hook of this.hooks.get("input") ?? []) {
			const event: InputEvent = {
				type: "input",
				text: currentText,
				images: currentImages,
				source,
				streamingBehavior,
			};
			const result = await this.dispatchHook(hook, "input", event, session, ui);
			if (result?.action === "handled") return result;
			if (result?.action === "transform") {
				currentText = result.text;
				currentImages = result.images ?? currentImages;
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}

	/**
	 * The `compact` chain (translated from the session_before_compact arm of
	 * ExtensionRunner.emit): last truthy result wins, `{ cancel }` short-circuits. Dedicated
	 * only because hooks have no generic observational emit to ride.
	 */
	async dispatchCompact(
		event: SessionBeforeCompactEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<SessionBeforeCompactResult | undefined> {
		let result: SessionBeforeCompactResult | undefined;

		for (const hook of this.hooks.get("compact") ?? []) {
			const handlerResult = await this.dispatchHook(hook, "compact", event, session, ui);

			if (handlerResult) {
				result = handlerResult;
				if (result.cancel) {
					return result;
				}
			}
		}

		return result;
	}

	/**
	 * Invoke a callable workflow by name. Unlike event dispatch there is a waiting caller:
	 * input is validated before the run opens, output inside it (an invalid output fails
	 * the run), and any failure is rethrown. Engine-internal in v1.
	 */
	async invoke(name: string, input: unknown): Promise<unknown> {
		const entry = this.callables.get(name);
		if (!entry) {
			throw new Error(`unknown callable workflow '${name}'`);
		}
		if (!entry.inputValidator.Check(input)) {
			const detail = entry.inputValidator
				.Errors(input)
				.map((e) => `${e.instancePath || "root"}: ${e.message}`)
				.join("; ");
			throw new Error(`invalid input for workflow '${name}'${detail ? `: ${detail}` : ""}`);
		}
		const outcome = await this.executeRun(
			entry.workflow.name,
			{ kind: "callable", input },
			async (journal, signal) => {
				const output = await entry.definition.run(input, this.createContext(journal, signal));
				if (!entry.outputValidator.Check(output)) {
					const detail = entry.outputValidator
						.Errors(output)
						.map((e) => `${e.instancePath || "root"}: ${e.message}`)
						.join("; ");
					throw new Error(`invalid output from workflow '${name}'${detail ? `: ${detail}` : ""}`);
				}
				return output;
			},
		);
		if (outcome.status !== "ok") throw outcome.error;
		return outcome.result;
	}

	/** Abort every in-flight run. Handlers observe it via ctx.signal; their runs end cancelled. */
	stop(): void {
		for (const controller of this.activeRuns) {
			controller.abort();
		}
	}

	/** Execute one event-dispatched run; a failed outcome surfaces on the error sink under `event`. */
	private async dispatchRun(
		workflow: Workflow,
		trigger: RunTrigger,
		event: string,
		handler: (journal: RunJournal, signal: AbortSignal) => unknown,
	): Promise<void> {
		const outcome = await this.executeRun(workflow.name, trigger, handler);
		if (outcome.status !== "error") return;
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		this.emitError({
			path: workflow.path,
			event,
			error: `workflow '${workflow.name}' failed: ${message}`,
			stack: outcome.error instanceof Error ? outcome.error.stack : undefined,
		});
	}

	/**
	 * Fire one hook as a recorded run over the event as it stands, and hand its result back
	 * to the chain. Fail-open is uniform: a thrown hook (or one cancelled mid-chain by
	 * stop()) records its outcome, surfaces on the error sink, and yields undefined so the
	 * chain proceeds with the event unchanged.
	 */
	private async dispatchHook<TEvent extends keyof HookEventMap>(
		hook: Hook,
		event: TEvent,
		eventObject: HookEventMap[TEvent],
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<HookResultMap[TEvent] | undefined> {
		const trigger: RunTrigger = { kind: "hook", event, payload: eventObject };
		const outcome = await this.executeRun(hook.name, trigger, (journal, signal) =>
			hook.definition.run(eventObject, this.createLifecycleContext(journal, signal, session, ui)),
		);
		if (outcome.status === "error") {
			const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
			this.emitError({
				path: hook.path,
				event,
				error: `hook '${hook.name}' failed: ${message}`,
				stack: outcome.error instanceof Error ? outcome.error.stack : undefined,
			});
			return undefined;
		}
		if (outcome.status === "cancelled") return undefined;
		return outcome.result as HookResultMap[TEvent] | undefined;
	}

	/**
	 * Open a journal and run the handler under a fresh AbortController. Never throws. The
	 * handler receives the raw journal/signal pair and builds its own ctx: the lifecycle
	 * dispatch needs the journal to wrap its binding's session, so ctx construction lives
	 * at the dispatch sites. Takes the run name directly — hooks are not workflows, and it
	 * was all executeRun ever read off one.
	 */
	private async executeRun(
		name: string,
		trigger: RunTrigger,
		handler: (journal: RunJournal, signal: AbortSignal) => unknown,
	): Promise<RunOutcome> {
		const journal = new RunJournal({
			workflow: name,
			trigger,
			generation: this.generation,
			runsDir: this.runsDir,
		});
		this.journals.push(journal);
		const controller = new AbortController();
		this.activeRuns.add(controller);
		try {
			const result = await handler(journal, controller.signal);
			journal.endRun("ok");
			return { status: "ok", result };
		} catch (error) {
			// Cancelled only for abort-caused rejections; a genuine failure thrown after
			// stop() is still filed (and surfaced) as an error.
			const aborted =
				controller.signal.aborted &&
				(error === controller.signal.reason || (error instanceof Error && error.name === "AbortError"));
			if (aborted) {
				journal.endRun("cancelled");
				return { status: "cancelled", error };
			}
			journal.endRun("error", error);
			return { status: "error", error };
		} finally {
			this.activeRuns.delete(controller);
		}
	}

	/** Build the per-run ctx handed to the handler. Everything it does lands in the journal as steps. */
	private createContext(journal: RunJournal, signal: AbortSignal): WorkflowContext {
		const backend = this.backend;
		const agent: WorkflowAgent = {
			cwd: backend.cwd,
			findSessions: (filter) =>
				journal.step("agent.findSessions", () => backend.findSessions(filter), { kind: "auto", args: filter }),
			listSessions: () => journal.step("agent.listSessions", () => backend.listSessions(), { kind: "auto" }),
			openSession: (id) => this.runSessionStep(journal, "agent.openSession", id, () => backend.openSession(id)),
			createSession: (options) =>
				this.runSessionStep(journal, "agent.createSession", undefined, () => backend.createSession(options)),
		};
		return {
			agent,
			integration: <TActions>(key: IntegrationKey<TActions>, account = "default") =>
				this.createIntegrationHandle(journal, key, account),
			step: (name, fn) => journal.step(name, fn, { kind: "user" }),
			signal,
		};
	}

	/**
	 * Build the gated ctx for a session-scoped run (lifecycle workflows and every hook): the
	 * base ctx plus the producing session (deliveries recorded as steps) and its dialog UI.
	 */
	private createLifecycleContext(
		journal: RunJournal,
		signal: AbortSignal,
		session: WorkflowSession,
		ui: DialogUI,
	): LifecycleWorkflowContext {
		return { ...this.createContext(journal, signal), session: this.createRecordedSession(journal, session), ui };
	}

	/** Wrap a session so its deliveries record as steps of this run; tag reads/writes pass straight through. */
	private createRecordedSession(journal: RunJournal, session: WorkflowSession): WorkflowSession {
		return {
			id: session.id,
			prompt: (text, options) =>
				journal.step("session.prompt", () => session.prompt(text, options), { kind: "auto", args: text }),
			sendUserMessage: (content, options) =>
				journal.step("session.sendUserMessage", () => session.sendUserMessage(content, options), {
					kind: "auto",
					args: content,
				}),
			getTags: () => session.getTags(),
			setTags: (tags) => session.setTags(tags),
		};
	}

	/** Build the flat action handle `ctx.integration(key)` returns; every action call records a step. */
	private createIntegrationHandle<TActions>(
		journal: RunJournal,
		key: IntegrationKey<TActions>,
		account: string,
	): IntegrationHandleOf<TActions> {
		const handle = this.integrations.getIntegration(key.service, account);
		const capability = this.integrations.getServiceCapabilities().find((c) => c.service === key.service);
		// A plain object over the registered action names: a typo'd or stale action fails as
		// a missing property, and no property is fabricated (a Proxy handle would fabricate
		// `then` and hang any accidental `await ctx.integration(key)`). The cast covers the
		// phantom `_actions` carrier, which has no runtime counterpart to derive from.
		const actions: Record<string, (params: unknown) => Promise<unknown>> = {};
		for (const action of capability?.actions ?? []) {
			actions[action] = (params) =>
				journal.step(`integration.call ${action}`, () => handle.call(action, params), {
					kind: "auto",
					args: params,
				});
		}
		return actions as IntegrationHandleOf<TActions>;
	}

	/**
	 * Bracket a session-producing backend call: the step records the session id as its
	 * result — identity, not the live object — and the returned handle records its own
	 * deliveries against the same journal (rehydrated handle semantics).
	 */
	private async runSessionStep(
		journal: RunJournal,
		name: string,
		args: unknown,
		open: () => Promise<WorkflowSession>,
	): Promise<WorkflowSession> {
		const stepId = journal.startStep(name, { kind: "auto", args });
		try {
			const session = await open();
			journal.endStep(stepId, { status: "ok", result: session.id });
			return this.createRecordedSession(journal, session);
		} catch (error) {
			journal.endStep(stepId, { status: "error", error });
			throw error;
		}
	}

	private triggerKey(service: string, event: string): string {
		return `${service} ${event}`;
	}

	private emitError(error: WorkflowError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}
}
