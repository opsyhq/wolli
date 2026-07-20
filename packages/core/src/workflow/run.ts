import { eq } from "drizzle-orm";
import {
  rehydrateError,
  serializeError,
  WorkflowCancelledError,
} from "./errors.ts";
import type { WorkflowDb } from "./schema.ts";
import { workflowEvents, workflowRuns } from "./schema.ts";

export interface StartOptions {
  runId?: string;
}

export interface WorkflowHandle<O> {
  readonly runId: string;
  result(): Promise<O>;
  cancel(): Promise<void>;
}

export type RunRow = typeof workflowRuns.$inferSelect;

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

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

/** Idempotently persists the run row + run_created event. */
export async function createRun(
  db: WorkflowDb,
  workflowName: string,
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
        workflowName,
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

/** Logged once per execution attempt: start + each resume. */
export async function markRunStarted(
  db: WorkflowDb,
  runId: string,
): Promise<void> {
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .insert(workflowEvents)
      .values({ runId, type: "run_started", createdAt: ts });
    await tx
      .update(workflowRuns)
      .set({ status: "running", updatedAt: ts })
      .where(eq(workflowRuns.id, runId));
  });
}

export async function markRunCompleted(
  db: WorkflowDb,
  runId: string,
  output: string,
): Promise<void> {
  const ts = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .insert(workflowEvents)
      .values({ runId, type: "run_completed", createdAt: ts });
    await tx
      .update(workflowRuns)
      .set({ status: "completed", output, updatedAt: ts })
      .where(eq(workflowRuns.id, runId));
  });
}

export async function markRunFailed(
  db: WorkflowDb,
  runId: string,
  error: unknown,
): Promise<void> {
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
      .set({ status: "failed", error: serializeError(error), updatedAt: ts })
      .where(eq(workflowRuns.id, runId));
  });
}

export async function markRunCancelled(
  db: WorkflowDb,
  runId: string,
): Promise<void> {
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
export function createTerminalRunHandle(
  run: RunRow,
  cancel: () => Promise<void>,
): WorkflowHandle<unknown> {
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
  return { runId: run.id, result: () => result, cancel };
}
