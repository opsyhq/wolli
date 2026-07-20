import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text().primaryKey(),
    workflowName: text("workflow_name").notNull(),
    status: text({ enum: RUN_STATUSES }).notNull(),
    input: text().notNull(), // JSON
    output: text(), // JSON when completed
    error: text(), // serializeError() output when failed
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    parentRunId: text("parent_run_id"),
    parentStepSeq: integer("parent_step_seq"),
    createdAt: text("created_at").notNull(), // ISO-8601 UTC
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("workflow_runs_status_idx").on(t.status),
    index("workflow_runs_parent_run_id_idx").on(t.parentRunId),
  ],
);

// Append-only event log; workflow_runs/workflow_steps are projections of it.
export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    seq: integer(), // step seq for step_* events, NULL for run_*
    type: text({ enum: EVENT_TYPES }).notNull(),
    // run_failed/step_failed: serializeError() output; step_created: {name};
    // step_retrying: {attempt, error} with error a serializeError() string;
    // others NULL
    data: text(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("workflow_events_run_id_id_idx").on(t.runId, t.id)],
);

export const workflowSteps = sqliteTable(
  "workflow_steps",
  {
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    seq: integer().notNull(), // per-run monotonic counter (memo key)
    name: text().notNull(),
    status: text({ enum: STEP_STATUSES }).notNull(),
    params: text().notNull(), // JSON
    output: text(),
    error: text(),
    attempts: integer().notNull().default(1),
    childRunId: text("child_run_id"), // non-NULL iff this op is a ctx.child call
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

// The run's durable output stream: one row per emitted chunk, ended by an
// `eof` row. Read by cursor (`id`) for replay/reconnect; never read by replay
// of the workflow itself — that uses workflow_steps.
export const workflowStreamChunks = sqliteTable(
  "workflow_stream_chunks",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    streamId: text("stream_id").notNull(), // = run id today; named streams later
    stepSeq: integer("step_seq"), // NULL on eof and run-level rows
    eof: integer({ mode: "boolean" }).notNull().default(false),
    data: text(), // one JSON chunk; NULL on the eof row
  },
  (t) => [index("workflow_stream_chunks_run_id_id_idx").on(t.runId, t.id)],
);

export const workflowSchema = {
  workflowRuns,
  workflowEvents,
  workflowSteps,
  workflowStreamChunks,
};

/**
 * A drizzle sqlite-dialect database over the workflow schema. Typed to accept
 * both sync (bun:sqlite) and async (Cloudflare D1) drivers — engine code
 * always awaits.
 */
export type WorkflowDb = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  typeof workflowSchema
>;

export type WorkflowTx = SQLiteTransaction<
  "sync" | "async",
  unknown,
  typeof workflowSchema,
  ExtractTablesWithRelations<typeof workflowSchema>
>;
