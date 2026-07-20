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

export interface RetryOptions {
  /** Total attempts including the first. Default 1 (no retries). */
  maxAttempts?: number;
  /** Delay before the first retry. Default 100. */
  initialDelayMs?: number;
  /** Multiplier applied per retry. Default 2. */
  backoffFactor?: number;
  /** Upper bound on any single delay. Default 30_000. */
  maxDelayMs?: number;
}

export interface StepDefinition<P, R> {
  readonly kind: "step";
  readonly name: string;
  readonly run: (params: P) => Promise<R>;
  readonly retry: Required<RetryOptions>;
}

export interface WorkflowContext {
  readonly runId: string;
  step<P, R>(step: StepDefinition<P, R>, params: P): Promise<R>;
  child<I, O>(workflow: Workflow<I, O>, input: I): Promise<O>;
}

export interface StartOptions {
  runId?: string;
}

export interface Workflow<I, O> {
  readonly kind: "workflow";
  readonly name: string;
  readonly run: (ctx: WorkflowContext, input: I) => Promise<O>;
}

export interface WorkflowHandle<O> {
  readonly runId: string;
  result(): Promise<O>;
  cancel(): Promise<void>;
}

export const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = ["running", "completed", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const EVENT_TYPES = [
  "run_created",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "step_created",
  "step_started",
  "step_completed",
  "step_failed",
  "step_retrying",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function defineWorkflow<I, O>(
  name: string,
  run: (ctx: WorkflowContext, input: I) => Promise<O>,
): Workflow<I, O> {
  return { kind: "workflow", name, run };
}

// biome-ignore lint/suspicious/noExplicitAny: type-erased registry entry; `any` keeps concrete workflows assignable in both variance directions
export type AnyWorkflow = Workflow<any, any>;

export function defineStep<P, R>(
  name: string,
  run: (params: P) => Promise<R>,
  opts?: RetryOptions,
): StepDefinition<P, R> {
  return {
    kind: "step",
    name,
    run,
    retry: {
      maxAttempts: opts?.maxAttempts ?? 1,
      initialDelayMs: opts?.initialDelayMs ?? 100,
      backoffFactor: opts?.backoffFactor ?? 2,
      maxDelayMs: opts?.maxDelayMs ?? 30_000,
    },
  };
}
