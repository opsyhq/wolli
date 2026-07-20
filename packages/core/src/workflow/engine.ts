import { desc, eq } from "drizzle-orm";
import { WorkflowCancelledError } from "./errors.ts";
import type { CancelSignal, StartOptions, WorkflowHandle } from "./run.ts";
import {
  createCancelSignal,
  createRun,
  createTerminalRunHandle,
  markRunCancelled,
  markRunCompleted,
  markRunFailed,
  markRunStarted,
  TERMINAL_STATUSES,
} from "./run.ts";
import type { WorkflowDb } from "./schema.ts";
import { workflowRuns, workflowSteps } from "./schema.ts";
import type { StepDefinition, StepRunState } from "./step.ts";
import { executeChildStep, executeStep } from "./step.ts";
import type { AnyWorkflow, Workflow, WorkflowContext } from "./workflow.ts";

export interface CreateEngineOptions {
  db: WorkflowDb;
  workflows: AnyWorkflow[];
}

export interface Engine {
  start<I, O>(
    workflow: Workflow<I, O>,
    input: I,
    opts?: StartOptions,
  ): Promise<WorkflowHandle<O>>;
  /** Resumes an interrupted OR failed run from its last checkpoint. */
  resume(runId: string): Promise<WorkflowHandle<unknown>>;
  cancel(runId: string): Promise<void>;
}

export function createEngine(options: CreateEngineOptions): Engine {
  const { db } = options;
  const registry = new Map<string, AnyWorkflow>();
  const inflight = new Map<
    string,
    { handle: WorkflowHandle<unknown>; cancel: CancelSignal }
  >();

  function register(workflow: AnyWorkflow): void {
    const existing = registry.get(workflow.name);
    if (existing && existing !== workflow) {
      throw new Error(
        `A different workflow named "${workflow.name}" is already registered with this engine`,
      );
    }
    registry.set(workflow.name, workflow);
  }

  /**
   * Executes a persisted run in the background and returns its handle.
   * Execution replays the workflow function from the top; step memoization
   * turns completed operations into instant returns, which is what makes a
   * resumed run continue instead of redo.
   */
  function executeRun(
    workflow: AnyWorkflow,
    runId: string,
  ): WorkflowHandle<unknown> {
    const cancel = createCancelSignal(runId);
    const execution = (async (): Promise<unknown> => {
      try {
        const run = (
          await db
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.id, runId))
            .limit(1)
        ).at(0);
        if (!run) throw new Error(`Unknown workflow run "${runId}"`);
        if (run.cancelRequested || cancel.requested) {
          await markRunCancelled(db, runId);
          throw new WorkflowCancelledError(runId);
        }
        let redriveSeq: number | null = null;
        if (run.status === "failed") {
          // Manual resume of a failed run: only the failure that killed the
          // run re-executes. Failed steps the workflow caught replay as throws.
          const lastStep = (
            await db
              .select()
              .from(workflowSteps)
              .where(eq(workflowSteps.runId, runId))
              .orderBy(desc(workflowSteps.seq))
              .limit(1)
          ).at(0);
          if (lastStep && lastStep.status === "failed") {
            redriveSeq = lastStep.seq;
          }
        }
        await markRunStarted(db, runId);
        const stepState: StepRunState = { db, runId, cancel, redriveSeq };
        // The seq counter starts at 0 on every execution attempt — that reset
        // is the replay mechanism: a resumed run's step calls land on the same
        // seqs as last time and hit the memoized rows.
        let nextSeq = 0;
        const ctx: WorkflowContext = {
          runId,
          step<P, R>(stepDef: StepDefinition<P, R>, params: P): Promise<R> {
            const seq = nextSeq;
            nextSeq += 1;
            return executeStep(stepState, seq, stepDef, params);
          },
          child<I, O>(childWorkflow: Workflow<I, O>, input: I): Promise<O> {
            const seq = nextSeq;
            nextSeq += 1;
            return executeChildStep(
              stepState,
              seq,
              childWorkflow.name,
              input,
              (childRunId) =>
                runChild(childWorkflow, input, childRunId, runId, seq),
            ) as Promise<O>;
          },
        };
        try {
          const output = await workflow.run(ctx, JSON.parse(run.input));
          await markRunCompleted(db, runId, JSON.stringify(output) ?? "null");
          return output;
        } catch (error) {
          if (error instanceof WorkflowCancelledError) {
            await markRunCancelled(db, runId);
          } else {
            await markRunFailed(db, runId, error);
          }
          throw error;
        }
      } finally {
        inflight.delete(runId);
      }
    })();
    execution.catch(() => {});
    const handle: WorkflowHandle<unknown> = {
      runId,
      result: () => execution,
      cancel: () => cancelRun(runId),
    };
    inflight.set(runId, { handle, cancel });
    return handle;
  }

  /** Runs a child idempotently and returns its outcome; replay re-attaches. */
  async function runChild(
    workflow: AnyWorkflow,
    input: unknown,
    childRunId: string,
    parentRunId: string,
    parentStepSeq: number,
  ): Promise<unknown> {
    register(workflow);
    const created = await createRun(db, workflow.name, childRunId, input, {
      runId: parentRunId,
      stepSeq: parentStepSeq,
    });
    if (!created) {
      const run = (
        await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, childRunId))
          .limit(1)
      ).at(0);
      if (!run) throw new Error(`Unknown workflow run "${childRunId}"`);
      if (run.status === "completed") {
        return run.output === null ? null : JSON.parse(run.output);
      }
      if (run.status === "cancelled") {
        throw new WorkflowCancelledError(childRunId);
      }
      // pending/running/failed → execution resumes the child's own checkpoint.
    }
    const handle =
      inflight.get(childRunId)?.handle ?? executeRun(workflow, childRunId);
    return handle.result();
  }

  async function startRun(
    workflow: AnyWorkflow,
    input: unknown,
    opts?: StartOptions,
  ): Promise<WorkflowHandle<unknown>> {
    register(workflow);
    const runId = opts?.runId ?? crypto.randomUUID();
    const created = await createRun(db, workflow.name, runId, input);
    if (!created) {
      const run = (
        await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .limit(1)
      ).at(0);
      if (!run) throw new Error(`Unknown workflow run "${runId}"`);
      if (run.workflowName !== workflow.name) {
        throw new Error(
          `Run "${runId}" belongs to workflow "${run.workflowName}", not "${workflow.name}"`,
        );
      }
      if (TERMINAL_STATUSES.has(run.status)) {
        return createTerminalRunHandle(run, () => cancelRun(run.id));
      }
    }
    return inflight.get(runId)?.handle ?? executeRun(workflow, runId);
  }

  async function resumeRun(runId: string): Promise<WorkflowHandle<unknown>> {
    const run = (
      await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .limit(1)
    ).at(0);
    if (!run) throw new Error(`Unknown workflow run "${runId}"`);
    const workflow = registry.get(run.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow "${run.workflowName}" is not registered with this engine; pass it to createEngine({ workflows }) to resume run "${runId}"`,
      );
    }
    if (run.status === "completed" || run.status === "cancelled") {
      return createTerminalRunHandle(run, () => cancelRun(run.id));
    }
    return inflight.get(runId)?.handle ?? executeRun(workflow, runId);
  }

  async function cancelRun(runId: string): Promise<void> {
    const run = (
      await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .limit(1)
    ).at(0);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    await db
      .update(workflowRuns)
      .set({ cancelRequested: true, updatedAt: new Date().toISOString() })
      .where(eq(workflowRuns.id, runId));
    const running = inflight.get(runId);
    if (running) {
      // Wakes retry sleeps and child awaits; execution logs run_cancelled.
      running.cancel.trigger();
    } else {
      // Interrupted run with no driver — finalize directly.
      await markRunCancelled(db, runId);
    }
  }

  for (const workflow of options.workflows) {
    register(workflow);
  }

  return {
    start<I, O>(
      workflow: Workflow<I, O>,
      input: I,
      opts?: StartOptions,
    ): Promise<WorkflowHandle<O>> {
      return startRun(workflow, input, opts) as Promise<WorkflowHandle<O>>;
    },
    resume: resumeRun,
    cancel: cancelRun,
  };
}
