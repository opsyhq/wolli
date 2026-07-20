import { and, eq } from "drizzle-orm";
import {
  NonDeterminismError,
  rehydrateError,
  serializeError,
  WorkflowCancelledError,
} from "./errors.ts";
import type { WorkflowDb } from "./schema.ts";
import { workflowEvents, workflowSteps } from "./schema.ts";
import type {
  AnyWorkflow,
  StepDefinition,
  Workflow,
  WorkflowContext,
} from "./types.ts";

export interface CancelSignal {
  requested: boolean;
  /** Rejects with WorkflowCancelledError when trigger() is called. */
  readonly promise: Promise<never>;
  trigger(): void;
}

export function createCancelSignal(runId: string): CancelSignal {
  const { promise, reject } = Promise.withResolvers<never>();
  promise.catch(() => {});
  const signal: CancelSignal = {
    requested: false,
    promise,
    trigger() {
      if (signal.requested) return;
      signal.requested = true;
      reject(new WorkflowCancelledError(runId));
    },
  };
  return signal;
}

/** Engine internals handed to the per-run context; avoids a circular import. */
export interface RunContextState {
  db: WorkflowDb;
  runId: string;
  cancel: CancelSignal;
  /**
   * When resuming a failed run, the seq of the step whose failure killed the
   * run — that one step re-executes instead of replaying its stored error.
   */
  redriveSeq: number | null;
  runChild(
    workflow: AnyWorkflow,
    input: unknown,
    childRunId: string,
    parentStepSeq: number,
  ): Promise<unknown>;
}

export function createRunContext(state: RunContextState): WorkflowContext {
  const { db, runId, cancel, redriveSeq, runChild } = state;
  let nextSeq = 0;

  async function createStep(
    seq: number,
    name: string,
    params: string,
    childRunId: string | null,
  ): Promise<void> {
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
  async function restartStep(seq: number): Promise<void> {
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

  async function markStepCompleted(seq: number, output: string): Promise<void> {
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

  async function markStepFailed(seq: number, error: unknown): Promise<void> {
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
        .set({
          status: "failed",
          error: serializeError(error),
          updatedAt: ts,
        })
        .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.seq, seq)));
    });
  }

  async function step<P, R>(
    stepDef: StepDefinition<P, R>,
    params: P,
  ): Promise<R> {
    if (cancel.requested) throw new WorkflowCancelledError(runId);
    const seq = nextSeq;
    nextSeq += 1;
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
      await restartStep(seq);
    } else {
      await createStep(
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
        const result = await Promise.race([
          stepDef.run(params),
          cancel.promise,
        ]);
        await markStepCompleted(seq, JSON.stringify(result) ?? "null");
        return result;
      } catch (error) {
        if (error instanceof WorkflowCancelledError) throw error;
        if (attempt >= maxAttempts) {
          await markStepFailed(seq, error);
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

  async function child<I, O>(workflow: Workflow<I, O>, input: I): Promise<O> {
    if (cancel.requested) throw new WorkflowCancelledError(runId);
    const seq = nextSeq;
    nextSeq += 1;
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
      if (recorded.childRunId === null || recorded.name !== workflow.name) {
        throw new NonDeterminismError(
          `Replay drift in run "${runId}" at seq ${seq}: the log recorded ${recorded.childRunId === null ? "step" : "child workflow"} "${recorded.name}" but this execution requested child workflow "${workflow.name}". Workflow code must be deterministic.`,
        );
      }
      if (recorded.status === "completed") {
        return JSON.parse(recorded.output ?? "null") as O;
      }
      if (recorded.status === "failed" && seq !== redriveSeq) {
        throw recorded.error === null
          ? new Error(`Step failure in run "${runId}" has no recorded error`)
          : rehydrateError(recorded.error);
      }
      await restartStep(seq);
    } else {
      await createStep(
        seq,
        workflow.name,
        JSON.stringify(input) ?? "null",
        childRunId,
      );
    }
    try {
      const result = await Promise.race([
        runChild(workflow, input, childRunId, seq),
        cancel.promise,
      ]);
      await markStepCompleted(seq, JSON.stringify(result) ?? "null");
      return result as O;
    } catch (error) {
      if (error instanceof WorkflowCancelledError && cancel.requested) {
        // Parent cancellation, not a child outcome: leave the step "running"
        // so a later resume re-attaches to the child.
        throw error;
      }
      await markStepFailed(seq, error);
      throw error;
    }
  }

  return { runId, step, child };
}
