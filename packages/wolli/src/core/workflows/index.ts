/**
 * Workflow subsystem: first-class, observable routing and automation. One defineWorkflow
 * file per workflow in the agent home's `workflows/` folder; every trigger firing is a
 * recorded run. Hooks — the interception surface, one defineHook file per hook in the
 * `hooks/` folder — run on the same engine.
 */

export {
	defineHook,
	type Hook,
	type HookDefinition,
	type HookEventMap,
	type HookResultMap,
	type LoadHooksResult,
} from "./hooks.ts";
export { RunJournal, type RunJournalOptions, type StepOptions } from "./journal.ts";
export { loadWorkflows } from "./loader.ts";
export { type WorkflowAgentBackend, WorkflowRunner, type WorkflowRunnerOptions } from "./runner.ts";
export type {
	AgentEventMap,
	CallableWorkflowDefinition,
	DialogUI,
	IntegrationEventDescriptor,
	IntegrationHandleOf,
	IntegrationKey,
	IntegrationWorkflowDefinition,
	LifecycleWorkflowContext,
	LifecycleWorkflowDefinition,
	LoadWorkflowsResult,
	RecordedError,
	RunEndRecord,
	RunRecord,
	RunStartRecord,
	RunStatus,
	RunTrigger,
	StepEndRecord,
	StepKind,
	StepStartRecord,
	Workflow,
	WorkflowAgent,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowError,
	WorkflowErrorListener,
	WorkflowKind,
	WorkflowSession,
} from "./types.ts";
export { defineWorkflow, getWorkflowKind } from "./types.ts";
