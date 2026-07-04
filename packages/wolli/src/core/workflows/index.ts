/**
 * Workflow subsystem: first-class, observable routing and automation. One defineWorkflow
 * file per workflow in the agent home's `workflows/` folder; every trigger firing is a
 * recorded run.
 */

export { RunJournal, type RunJournalOptions, type StepOptions } from "./journal.ts";
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
