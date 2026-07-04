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
	CallableWorkflowDefinition,
	IntegrationHandleOf,
	IntegrationKey,
	IntegrationWorkflowDefinition,
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
	/** Workflow name → callable with its precompiled schema validators. */
	private readonly callables = new Map<string, CallableEntry>();

	private readonly journals: RunJournal[] = [];
	/** Controllers of in-flight runs; `stop()` fires them. */
	private readonly activeRuns = new Set<AbortController>();
	private readonly errorListeners = new Set<WorkflowErrorListener>();

	constructor(workflows: Workflow[], options: WorkflowRunnerOptions) {
		this.backend = options.backend;
		this.integrations = options.integrations;
		this.generation = options.generation;
		this.runsDir = options.runsDir;

		// Index triggers. Lifecycle workflows (`on` as an event literal) are accepted but not
		// yet indexed: their dispatch, and the session-bearing ctx it needs, land next.
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
			} else if (typeof definition.on !== "string") {
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
			const outcome = await this.executeRun(workflow, trigger, (ctx) => definition.run(payload, ctx));
			if (outcome.status === "error") {
				const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
				this.emitError({
					path: workflow.path,
					event: `${service}.${event}`,
					error: `workflow '${workflow.name}' failed: ${message}`,
					stack: outcome.error instanceof Error ? outcome.error.stack : undefined,
				});
			}
		}
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
		const outcome = await this.executeRun(entry.workflow, { kind: "callable", input }, async (ctx) => {
			const output = await entry.definition.run(input, ctx);
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

	/** Open a journal and run the handler under a fresh AbortController. Never throws. */
	private async executeRun(
		workflow: Workflow,
		trigger: RunTrigger,
		handler: (ctx: WorkflowContext) => unknown,
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
			const result = await handler(this.createContext(journal, controller.signal));
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
