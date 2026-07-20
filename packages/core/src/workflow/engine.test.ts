import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { WorkflowDb } from "./index.ts";
import {
  createEngine,
  defineStep,
  defineWorkflow,
  WorkflowCancelledError,
  workflowEvents,
  workflowRuns,
  workflowSchema,
  workflowSteps,
} from "./index.ts";

function createTestDb(): WorkflowDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema: workflowSchema });
  migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
  return db;
}

const eventsFor = (db: WorkflowDb, runId: string) =>
  db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .orderBy(asc(workflowEvents.id));

const eventTypes = async (db: WorkflowDb, runId: string) =>
  (await eventsFor(db, runId)).map((e) => e.type);

const runRow = async (db: WorkflowDb, runId: string) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId))).at(
    0,
  );

const stepRows = (db: WorkflowDb, runId: string) =>
  db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.runId, runId))
    .orderBy(asc(workflowSteps.seq));

async function until(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
}

test("end-to-end two-step run: output, projections, exact event sequence", async () => {
  const db = createTestDb();
  let doubleCalls = 0;
  const double = defineStep("double", async ({ value }: { value: number }) => {
    doubleCalls += 1;
    return value * 2;
  });
  const exclaim = defineStep(
    "exclaim",
    async ({ text }: { text: string }) => `${text}!`,
  );
  const wf = defineWorkflow("two-step", async (ctx, input: { n: number }) => {
    const doubled = await ctx.step(double, { value: input.n });
    const shout = await ctx.step(exclaim, { text: `n=${doubled}` });
    return { doubled, shout };
  });
  const engine = createEngine({ db, workflows: [wf] });

  const handle = await engine.start(wf, { n: 21 });
  await expect(handle.result()).resolves.toEqual({
    doubled: 42,
    shout: "n=42!",
  });
  expect(doubleCalls).toBe(1);

  const run = await runRow(db, handle.runId);
  expect(run?.status).toBe("completed");
  expect(run?.workflowName).toBe("two-step");
  expect(JSON.parse(run?.output ?? "null")).toEqual({
    doubled: 42,
    shout: "n=42!",
  });

  const steps = await stepRows(db, handle.runId);
  expect(steps.length).toBe(2);
  expect(steps[0]?.name).toBe("double");
  expect(steps[0]?.status).toBe("completed");
  expect(steps[0]?.params).toBe(JSON.stringify({ value: 21 }));
  expect(steps[0]?.output).toBe("42");
  expect(steps[1]?.name).toBe("exclaim");
  expect(steps[1]?.output).toBe(JSON.stringify("n=42!"));

  expect(await eventTypes(db, handle.runId)).toEqual([
    "run_created",
    "run_started",
    "step_created",
    "step_started",
    "step_completed",
    "step_created",
    "step_started",
    "step_completed",
    "run_completed",
  ]);
});

test("failing run: rejects, run failed with {name,message}, ends step_failed, run_failed", async () => {
  const db = createTestDb();
  const boom = defineStep("boom", async () => {
    throw new Error("kaput");
  });
  const wf = defineWorkflow("fails", async (ctx) => {
    await ctx.step(boom, null);
    return "unreachable";
  });
  const engine = createEngine({ db, workflows: [wf] });

  const handle = await engine.start(wf, null);
  await expect(handle.result()).rejects.toThrow("kaput");

  const run = await runRow(db, handle.runId);
  expect(run?.status).toBe("failed");
  const error = JSON.parse(run?.error ?? "{}");
  expect(error.name).toBe("Error");
  expect(error.message).toBe("kaput");

  const types = await eventTypes(db, handle.runId);
  expect(types.slice(-2)).toEqual(["step_failed", "run_failed"]);
});

test("auto-retry: fail twice then succeed with maxAttempts 3", async () => {
  const db = createTestDb();
  let calls = 0;
  const flaky = defineStep(
    "flaky",
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "ok";
    },
    { maxAttempts: 3, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 },
  );
  const wf = defineWorkflow("retries", async (ctx) => ctx.step(flaky, null));
  const engine = createEngine({ db, workflows: [wf] });

  const handle = await engine.start(wf, null);
  await expect(handle.result()).resolves.toBe("ok");
  expect(calls).toBe(3);

  const steps = await stepRows(db, handle.runId);
  expect(steps[0]?.attempts).toBe(3);
  expect(steps[0]?.status).toBe("completed");

  const retrying = (await eventsFor(db, handle.runId))
    .filter((e) => e.type === "step_retrying")
    .map((e) => JSON.parse(e.data ?? "{}"));
  expect(retrying.map((r) => r.attempt)).toEqual([2, 3]);
  expect(JSON.parse(retrying[0]?.error ?? "{}").message).toBe("fail 1");
});

test("cancel mid-run: rejects WorkflowCancelledError, run cancelled, last event run_cancelled", async () => {
  const db = createTestDb();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hang = defineStep("hang", async () => {
    await gate;
    return "done";
  });
  const wf = defineWorkflow("cancellable", async (ctx) => ctx.step(hang, null));
  const engine = createEngine({ db, workflows: [wf] });

  const handle = await engine.start(wf, null);
  await until(async () =>
    (await eventTypes(db, handle.runId)).includes("step_started"),
  );
  await engine.cancel(handle.runId);
  await expect(handle.result()).rejects.toBeInstanceOf(WorkflowCancelledError);

  expect((await runRow(db, handle.runId))?.status).toBe("cancelled");
  expect((await eventTypes(db, handle.runId)).at(-1)).toBe("run_cancelled");
  release?.();
});

test("cancel during a 5s retry sleep resolves promptly", async () => {
  const db = createTestDb();
  const failing = defineStep(
    "always-fails",
    async () => {
      throw new Error("nope");
    },
    { maxAttempts: 2, initialDelayMs: 5000 },
  );
  const wf = defineWorkflow("sleepy", async (ctx) => ctx.step(failing, null));
  const engine = createEngine({ db, workflows: [wf] });

  const handle = await engine.start(wf, null);
  await until(async () =>
    (await eventTypes(db, handle.runId)).includes("step_retrying"),
  );
  const started = performance.now();
  await engine.cancel(handle.runId);
  await expect(handle.result()).rejects.toBeInstanceOf(WorkflowCancelledError);
  expect(performance.now() - started).toBeLessThan(200);
  expect((await runRow(db, handle.runId))?.status).toBe("cancelled");
});

test("parent+child: deterministic child id, linkage both directions, child log", async () => {
  const db = createTestDb();
  const addOne = defineStep(
    "add-one",
    async ({ value }: { value: number }) => value + 1,
  );
  const double = defineStep(
    "double",
    async ({ value }: { value: number }) => value * 2,
  );
  const childWf = defineWorkflow(
    "child-wf",
    async (ctx, input: { n: number }) => {
      const doubled = await ctx.step(double, { value: input.n });
      return { doubled };
    },
  );
  const parentWf = defineWorkflow(
    "parent-wf",
    async (ctx, input: { n: number }) => {
      const bumped = await ctx.step(addOne, { value: input.n });
      const child = await ctx.child(childWf, { n: bumped });
      return { bumped, child };
    },
  );
  const engine = createEngine({ db, workflows: [parentWf] });

  const handle = await engine.start(
    parentWf,
    { n: 4 },
    { runId: "parent-run" },
  );
  await expect(handle.result()).resolves.toEqual({
    bumped: 5,
    child: { doubled: 10 },
  });

  const childRun = await runRow(db, "parent-run:1");
  expect(childRun?.workflowName).toBe("child-wf");
  expect(childRun?.parentRunId).toBe("parent-run");
  expect(childRun?.parentStepSeq).toBe(1);
  expect(childRun?.status).toBe("completed");
  expect(JSON.parse(childRun?.output ?? "null")).toEqual({ doubled: 10 });

  const parentSteps = await stepRows(db, "parent-run");
  expect(parentSteps[1]?.name).toBe("child-wf");
  expect(parentSteps[1]?.childRunId).toBe("parent-run:1");
  expect(parentSteps[1]?.status).toBe("completed");

  expect(await eventTypes(db, "parent-run:1")).toEqual([
    "run_created",
    "run_started",
    "step_created",
    "step_started",
    "step_completed",
    "run_completed",
  ]);
});

test("child failure propagates to the parent step and run", async () => {
  const db = createTestDb();
  const explode = defineStep("explode", async () => {
    throw new Error("child kaput");
  });
  const childWf = defineWorkflow("bad-child", async (ctx) =>
    ctx.step(explode, null),
  );
  const parentWf = defineWorkflow("sad-parent", async (ctx) =>
    ctx.child(childWf, null),
  );
  const engine = createEngine({ db, workflows: [parentWf] });

  const handle = await engine.start(parentWf, null, { runId: "sad" });
  await expect(handle.result()).rejects.toThrow("child kaput");

  expect((await runRow(db, "sad:0"))?.status).toBe("failed");
  expect((await runRow(db, "sad"))?.status).toBe("failed");
  const parentSteps = await stepRows(db, "sad");
  expect(parentSteps[0]?.status).toBe("failed");
  expect(parentSteps[0]?.childRunId).toBe("sad:0");
  expect(JSON.parse(parentSteps[0]?.error ?? "{}").message).toBe("child kaput");
});

test("idempotent start with a fixed runId: step ran once, log unchanged", async () => {
  const db = createTestDb();
  let calls = 0;
  const once = defineStep("once", async () => {
    calls += 1;
    return calls;
  });
  const wf = defineWorkflow("idem", async (ctx) => ctx.step(once, null));
  const engine = createEngine({ db, workflows: [wf] });

  const first = await engine.start(wf, null, { runId: "fixed" });
  await expect(first.result()).resolves.toBe(1);
  const eventCount = (await eventsFor(db, "fixed")).length;

  const second = await engine.start(wf, null, { runId: "fixed" });
  expect(second.runId).toBe("fixed");
  await expect(second.result()).resolves.toBe(1);
  expect(calls).toBe(1);
  expect((await eventsFor(db, "fixed")).length).toBe(eventCount);
});
