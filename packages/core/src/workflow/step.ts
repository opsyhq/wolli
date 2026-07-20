import { and, eq } from "drizzle-orm";
import {
  NonDeterminismError,
  rehydrateError,
  serializeError,
  WorkflowCancelledError,
} from "./errors.ts";
import type { CancelSignal } from "./run.ts";
import type { WorkflowDb } from "./schema.ts";
import { workflowEvents, workflowSteps } from "./schema.ts";

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

/** Per-run state every step execution needs. */
export interface StepRunState {
  db: WorkflowDb;
  runId: string;
  cancel: CancelSignal;
  /**
   * When resuming a failed run, the seq of the step whose failure killed the
   * run — that one step re-executes instead of replaying its stored error.
   */
  redriveSeq: number | null;
}

/** First execution at this seq: log step_created + step_started, insert the row. */
async function createStep(
  state: StepRunState,
  seq: number,
  name: string,
  params: string,
  childRunId: string | null,
): Promise<void> {
  const { db, runId } = state;
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(workflowEvents).values([
      {
        runId,
        seq,
        type: "step_created",
        data: JSON.stringify({ name }),
        createdAt: ts,
      },
      { runId, seq, type: "step_started", createdAt: ts },
    ]);
    await tx.insert(workflowSteps).values({
      runId,
      seq,
      name,
      status: "running",
      params,
      attempts: 1,
      childRunId,
      createdAt: ts,
      updatedAt: ts,
    });
  });
}

/** Re-execution after a crash mid-step or a redrive of the killing failure. */
async function restartStep(state: StepRunState, seq: number): Promise<void> {
  const { db, runId } = state;
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .insert(workflowEvents)
      .values({ runId, seq, type: "step_started", createdAt: ts });
    await tx
      .update(workflowSteps)
      .set({ status: "running", attempts: 1, error: null, updatedAt: ts })
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)));
  });
}

async function markStepCompleted(
  state: StepRunState,
  seq: number,
  output: string,
): Promise<void> {
  const { db, runId } = state;
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .insert(workflowEvents)
      .values({ runId, seq, type: "step_completed", createdAt: ts });
    await tx
      .update(workflowSteps)
      .set({ status: "completed", output, error: null, updatedAt: ts })
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)));
  });
}

async function markStepFailed(
  state: StepRunState,
  seq: number,
  error: unknown,
): Promise<void> {
  const { db, runId } = state;
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(workflowEvents).values({
      runId,
      seq,
      type: "step_failed",
      data: serializeError(error),
      createdAt: ts,
    });
    await tx
      .update(workflowSteps)
      .set({ status: "failed", error: serializeError(error), updatedAt: ts })
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)));
  });
}

/**
 * Executes (or replays) the step recorded at this seq: a completed step
 * returns its stored output without running, a failed one rethrows its stored
 * error (unless it is the redrive target), anything else runs the step
 * function through the retry loop.
 */
export async function executeStep<P, R>(
  state: StepRunState,
  seq: number,
  stepDef: StepDefinition<P, R>,
  params: P,
): Promise<R> {
  const { db, runId, cancel, redriveSeq } = state;
  if (cancel.requested) throw new WorkflowCancelledError(runId);
  const recorded = (
    await db
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)))
      .limit(1)
  ).at(0);
  if (recorded) {
    if (recorded.childRunId !== null || recorded.name !== stepDef.name) {
      throw new NonDeterminismError(
        `Replay drift in run "${runId}" at seq ${seq}: the log recorded ${recorded.childRunId === null ? "step" : "child workflow"} "${recorded.name}" but this execution requested step "${stepDef.name}". Workflow code must be deterministic.`,
      );
    }
    if (recorded.status === "completed") {
      return JSON.parse(recorded.output ?? "null") as R;
    }
    if (recorded.status === "failed" && seq !== redriveSeq) {
      throw recorded.error === null
        ? new Error(`Step failure in run "${runId}" has no recorded error`)
        : rehydrateError(recorded.error);
    }
    await restartStep(state, seq);
  } else {
    await createStep(
      state,
      seq,
      stepDef.name,
      JSON.stringify(params) ?? "null",
      null,
    );
  }
  const { backoffFactor, initialDelayMs, maxAttempts, maxDelayMs } =
    stepDef.retry;
  // Retries re-use this seq — the attempt loop is inside one durable op.
  for (let attempt = 1; ; attempt += 1) {
    if (cancel.requested) throw new WorkflowCancelledError(runId);
    try {
      // Race with the cancel signal so cancel() preempts a hung step; the
      // abandoned invocation is covered by at-least-once semantics.
      const result = await Promise.race([stepDef.run(params), cancel.promise]);
      await markStepCompleted(state, seq, JSON.stringify(result) ?? "null");
      return result;
    } catch (error) {
      if (error instanceof WorkflowCancelledError) throw error;
      if (attempt >= maxAttempts) {
        await markStepFailed(state, seq, error);
        throw error;
      }
      const ts = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.insert(workflowEvents).values({
          runId,
          seq,
          type: "step_retrying",
          data: JSON.stringify({
            attempt: attempt + 1,
            error: serializeError(error),
          }),
          createdAt: ts,
        });
        await tx
          .update(workflowSteps)
          .set({
            attempts: attempt + 1,
            error: serializeError(error),
            updatedAt: ts,
          })
          .where(
            and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)),
          );
      });
      const delayMs = Math.min(
        initialDelayMs * backoffFactor ** (attempt - 1),
        maxDelayMs,
      );
      // Sleep until the next attempt, waking immediately on cancel().
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        cancel.promise.catch((cancelError: unknown) => {
          clearTimeout(timer);
          reject(cancelError);
        });
      });
    }
  }
}

/**
 * Executes (or replays) a child-workflow call recorded as the step at this
 * seq. The child id is derived from (runId, seq), so replay re-attaches to
 * the same child instead of spawning a new one. `runChild` is the engine
 * callback that actually runs the child and returns its outcome.
 */
export async function executeChildStep(
  state: StepRunState,
  seq: number,
  workflowName: string,
  input: unknown,
  runChild: (childRunId: string) => Promise<unknown>,
): Promise<unknown> {
  const { db, runId, cancel, redriveSeq } = state;
  if (cancel.requested) throw new WorkflowCancelledError(runId);
  // Deterministic child id → idempotent re-spawn on replay.
  const childRunId = `${runId}:${seq}`;
  const recorded = (
    await db
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)))
      .limit(1)
  ).at(0);
  if (recorded) {
    if (recorded.childRunId === null || recorded.name !== workflowName) {
      throw new NonDeterminismError(
        `Replay drift in run "${runId}" at seq ${seq}: the log recorded ${recorded.childRunId === null ? "step" : "child workflow"} "${recorded.name}" but this execution requested child workflow "${workflowName}". Workflow code must be deterministic.`,
      );
    }
    if (recorded.status === "completed") {
      return JSON.parse(recorded.output ?? "null");
    }
    if (recorded.status === "failed" && seq !== redriveSeq) {
      throw recorded.error === null
        ? new Error(`Step failure in run "${runId}" has no recorded error`)
        : rehydrateError(recorded.error);
    }
    await restartStep(state, seq);
  } else {
    await createStep(
      state,
      seq,
      workflowName,
      JSON.stringify(input) ?? "null",
      childRunId,
    );
  }
  try {
    const result = await Promise.race([runChild(childRunId), cancel.promise]);
    await markStepCompleted(state, seq, JSON.stringify(result) ?? "null");
    return result;
  } catch (error) {
    if (error instanceof WorkflowCancelledError && cancel.requested) {
      // Parent cancellation, not a child outcome: leave the step "running"
      // so a later resume re-attaches to the child.
      throw error;
    }
    await markStepFailed(state, seq, error);
    throw error;
  }
}
