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

import { EVENT_TYPES, RUN_STATUSES, STEP_STATUSES } from "./types.ts";

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text().primaryKey(),
    workflowName: text("workflow_name").notNull(),
    status: text({ enum: RUN_STATUSES }).notNull(),
    input: text().notNull(), // JSON
    output: text(), // JSON when completed
    error: text(), // JSON {name,message,stack?} when failed
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

export const workflowSchema = { workflowRuns, workflowEvents, workflowSteps };

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
