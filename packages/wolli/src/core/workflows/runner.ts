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
 */

import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { NewSessionOptions } from "../extensions/types.ts";
import type { IntegrationRunner } from "../integrations/runner.ts";
import type { SessionInfo } from "../session.ts";
import { RunJournal } from "./journal.ts";
import type {
	AgentEventMap,
	CallableWorkflowDefinition,
	DialogUI,
	IntegrationHandleOf,
	IntegrationKey,
	IntegrationWorkflowDefinition,
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

	private readonly journals: RunJournal[] = [];
	/** Controllers of in-flight runs; `stop()` fires them. */
	private readonly activeRuns = new Set<AbortController>();
	private readonly errorListeners = new Set<WorkflowErrorListener>();
	/**
	 * Index-time load failures: a workflow whose integration trigger carries an unstamped
	 * descriptor (`service === ""`, i.e. the definition never passed through the integrations
	 * loader) is not indexed and lands here instead of binding silently under `" event"`.
	 */
	private readonly _indexErrors: Array<{ path: string; error: string }> = [];

	constructor(workflows: Workflow[], options: WorkflowRunnerOptions) {
		this.backend = options.backend;
		this.integrations = options.integrations;
		this.generation = options.generation;
		this.runsDir = options.runsDir;

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
			} else if (definition.on.service === "") {
				// An unstamped descriptor means the integration definition was not loaded from
				// integrations/, so the trigger addresses no real service — fail the index.
				this._indexErrors.push({
					path: workflow.path,
					error: `workflow '${workflow.name}': integration definition was not loaded from integrations/ (event descriptor has no service)`,
				});
			} else {
				const key = this.triggerKey(definition.on.service, definition.on.event);
				const bindings = this.integrationTriggers.get(key);
				if (bindings) bindings.push({ workflow, definition });
				else this.integrationTriggers.set(key, [{ workflow, definition }]);
			}
		}
	}

	/** Index-time load failures (unstamped integration triggers), surfaced in the resource summary. */
	get indexErrors(): ReadonlyArray<{ path: string; error: string }> {
		return this._indexErrors;
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
	 * Fire every workflow bound to (service, event) — the seam the IntegrationRunner's
	 * validated-event firehose wires into. Runs execute inline and sequentially; a failed
	 * run surfaces on the error sink and never throws back into the emitting producer.
	 */
	async dispatchIntegrationEvent(service: string, event: string, payload: unknown): Promise<void> {
		const bindings = this.integrationTriggers.get(this.triggerKey(service, event));
		if (!bindings) return;
		const trigger: RunTrigger = { kind: "integration", service, event, payload };
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
				definition.run(event, {
					...this.createContext(journal, signal),
					session: {
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
						getSessionName: () => session.getSessionName(),
						get model() {
							return session.model;
						},
					},
					ui,
				}),
			);
		}
	}

	/** Whether any workflow is bound to this lifecycle event — lets the runtime skip binding work. */
	hasTriggers(type: string): boolean {
		return this.lifecycleTriggers.has(type);
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
		const outcome = await this.executeRun(entry.workflow, { kind: "callable", input }, async (journal, signal) => {
			const output = await entry.definition.run(input, this.createContext(journal, signal));
			if (!entry.outputValidator.Check(output)) {
				const detail = entry.outputValidator
					.Errors(output)
					.map((e) => `${e.instancePath || "root"}: ${e.message}`)
					.join("; ");
				throw new Error(`invalid output from workflow '${name}'${detail ? `: ${detail}` : ""}`);
			}
			return output;
		});
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
		const outcome = await this.executeRun(workflow, trigger, handler);
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
	 * Open a journal and run the handler under a fresh AbortController. Never throws. The
	 * handler receives the raw journal/signal pair and builds its own ctx: the lifecycle
	 * dispatch needs the journal to wrap its binding's session, so ctx construction lives
	 * at the dispatch sites.
	 */
	private async executeRun(
		workflow: Workflow,
		trigger: RunTrigger,
		handler: (journal: RunJournal, signal: AbortSignal) => unknown,
	): Promise<RunOutcome> {
		const journal = new RunJournal({
			workflow: workflow.name,
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
			integration: <TActions>(key: IntegrationKey<TActions>) => this.createIntegrationHandle(journal, key),
			step: (name, fn) => journal.step(name, fn, { kind: "user" }),
			signal,
		};
	}

	/** Build the flat action handle `ctx.integration(key)` returns; every action call records a step. */
	private createIntegrationHandle<TActions>(
		journal: RunJournal,
		key: IntegrationKey<TActions>,
	): IntegrationHandleOf<TActions> {
		const handle = this.integrations.getIntegration(key.service);
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
				getSessionName: () => session.getSessionName(),
				get model() {
					return session.model;
				},
			};
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
