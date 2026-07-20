import { desc, eq } from "drizzle-orm";
import type { CancelSignal } from "./context.ts";
import { createCancelSignal, createRunContext } from "./context.ts";
import {
  rehydrateError,
  serializeError,
  WorkflowCancelledError,
} from "./errors.ts";
import type { WorkflowDb } from "./schema.ts";
import { workflowEvents, workflowRuns, workflowSteps } from "./schema.ts";
import type {
  AnyWorkflow,
  StartOptions,
  Workflow,
  WorkflowHandle,
} from "./types.ts";

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

type RunRow = typeof workflowRuns.$inferSelect;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

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

  /** Idempotently persists the run row + run_created event. */
  async function createRun(
    workflow: AnyWorkflow,
    runId: string,
    input: unknown,
    parent?: { runId: string; stepSeq: number },
  ): Promise<boolean> {
    const inputJson = JSON.stringify(input) ?? "null";
    const ts = new Date().toISOString();
    let created = false;
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(workflowRuns)
        .values({
          id: runId,
          workflowName: workflow.name,
          status: "pending",
          input: inputJson,
          parentRunId: parent?.runId ?? null,
          parentStepSeq: parent?.stepSeq ?? null,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing()
        .returning({ id: workflowRuns.id });
      if (rows.length > 0) {
        created = true;
        await tx
          .insert(workflowEvents)
          .values({ runId, type: "run_created", createdAt: ts });
      }
    });
    return created;
  }

  async function markRunCancelled(runId: string): Promise<void> {
    const ts = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .insert(workflowEvents)
        .values({ runId, type: "run_cancelled", createdAt: ts });
      await tx
        .update(workflowRuns)
        .set({ status: "cancelled", updatedAt: ts })
        .where(eq(workflowRuns.id, runId));
    });
  }

  /** The run already finished — its handle settles from the stored row. */
  function createTerminalRunHandle(run: RunRow): WorkflowHandle<unknown> {
    let result: Promise<unknown>;
    if (run.status === "completed") {
      result = Promise.resolve(
        run.output === null ? null : JSON.parse(run.output),
      );
    } else if (run.status === "failed") {
      result = Promise.reject(
        run.error === null
          ? new Error(`Workflow run "${run.id}" failed`)
          : rehydrateError(run.error),
      );
    } else {
      result = Promise.reject(new WorkflowCancelledError(run.id));
    }
    result.catch(() => {});
    return {
      runId: run.id,
      result: () => result,
      cancel: () => cancelRun(run.id),
    };
  }

  /**
   * Executes a persisted run in the background and returns its handle.
   * Execution replays the workflow function from the top; ctx memoization
   * turns completed operations into instant returns, which is what makes a
   * resumed run continue instead of redo. run_started is logged once per
   * execution attempt: start + each resume.
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
          await markRunCancelled(runId);
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
        const startedAt = new Date().toISOString();
        await db.transaction(async (tx) => {
          await tx
            .insert(workflowEvents)
            .values({ runId, type: "run_started", createdAt: startedAt });
          await tx
            .update(workflowRuns)
            .set({ status: "running", updatedAt: startedAt })
            .where(eq(workflowRuns.id, runId));
        });
        const ctx = createRunContext({
          db,
          runId,
          cancel,
          redriveSeq,
          runChild: (childWorkflow, childInput, childRunId, parentStepSeq) =>
            runChild(
              childWorkflow,
              childInput,
              childRunId,
              runId,
              parentStepSeq,
            ),
        });
        try {
          const output = await workflow.run(ctx, JSON.parse(run.input));
          const outputJson = JSON.stringify(output) ?? "null";
          const ts = new Date().toISOString();
          await db.transaction(async (tx) => {
            await tx
              .insert(workflowEvents)
              .values({ runId, type: "run_completed", createdAt: ts });
            await tx
              .update(workflowRuns)
              .set({ status: "completed", output: outputJson, updatedAt: ts })
              .where(eq(workflowRuns.id, runId));
          });
          return output;
        } catch (error) {
          if (error instanceof WorkflowCancelledError) {
            await markRunCancelled(runId);
          } else {
            const ts = new Date().toISOString();
            await db.transaction(async (tx) => {
              await tx.insert(workflowEvents).values({
                runId,
                type: "run_failed",
                data: serializeError(error),
                createdAt: ts,
              });
              await tx
                .update(workflowRuns)
                .set({
                  status: "failed",
                  error: serializeError(error),
                  updatedAt: ts,
                })
                .where(eq(workflowRuns.id, runId));
            });
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
    const created = await createRun(workflow, childRunId, input, {
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
    const created = await createRun(workflow, runId, input);
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
      if (TERMINAL_STATUSES.has(run.status))
        return createTerminalRunHandle(run);
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
      return createTerminalRunHandle(run);
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
      await markRunCancelled(runId);
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
