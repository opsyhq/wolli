/**
 * Workflow subsystem: first-class, observable routing and automation. One defineWorkflow
 * file per workflow in the agent home's `workflows/` folder; every trigger firing is a
 * recorded run.
 */

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
	WorkflowAgent,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowKind,
	WorkflowSession,
} from "./types.ts";
export { defineWorkflow, getWorkflowKind } from "./types.ts";
