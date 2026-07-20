/**
 * Determinism contract: a workflow body must branch only on its input and on
 * step results. All IO, time, and randomness belong inside steps. Steps are
 * executed at-least-once (a crash mid-step re-runs it on resume), so step
 * functions must be idempotent.
 *
 * Values crossing the durability boundary (inputs, params, outputs) are stored
 * with plain JSON.stringify semantics: `undefined` becomes null, circular
 * structures and BigInt throw.
 *
 * v1 is single-process: there is no cross-process locking. Driving the same
 * run from two processes concurrently is undefined behavior.
 */

import type { StepDefinition } from "./step.ts";

export interface WorkflowContext {
  readonly runId: string;
  step<P, R>(step: StepDefinition<P, R>, params: P): Promise<R>;
  child<I, O>(workflow: Workflow<I, O>, input: I): Promise<O>;
}

export interface Workflow<I, O> {
  readonly kind: "workflow";
  readonly name: string;
  readonly run: (ctx: WorkflowContext, input: I) => Promise<O>;
}

export function defineWorkflow<I, O>(
  name: string,
  run: (ctx: WorkflowContext, input: I) => Promise<O>,
): Workflow<I, O> {
  return { kind: "workflow", name, run };
}

// biome-ignore lint/suspicious/noExplicitAny: type-erased registry entry; `any` keeps concrete workflows assignable in both variance directions
export type AnyWorkflow = Workflow<any, any>;
