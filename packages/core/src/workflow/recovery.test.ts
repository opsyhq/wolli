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
  NonDeterminismError,
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

/** Hangs forever on the first invocation; resolves once `open()` was called. */
function makeGate() {
  let open = false;
  return {
    open: () => {
      open = true;
    },
    isOpen: () => open,
  };
}

test("interrupt + resume: completed steps memoized, hung step re-executes", async () => {
  const db = createTestDb();
  let aCalls = 0;
  const gate = makeGate();
  const stepA = defineStep("step-a", async () => {
    aCalls += 1;
    return "a-result";
  });
  const stepB = defineStep("step-b", async () => {
    if (!gate.isOpen()) return new Promise<string>(() => {});
    return "b-result";
  });
  const wf = defineWorkflow("resumable", async (ctx) => {
    const a = await ctx.step(stepA, null);
    const b = await ctx.step(stepB, null);
    return { a, b };
  });

  const engine1 = createEngine({ db, workflows: [wf] });
  await engine1.start(wf, null, { runId: "resumable-1" });
  await until(async () => (await stepRows(db, "resumable-1")).length === 2);

  // "Interrupt": abandon engine1 mid-step-B and resume on a fresh engine.
  gate.open();
  const engine2 = createEngine({ db, workflows: [wf] });
  const handle = await engine2.resume("resumable-1");
  await expect(handle.result()).resolves.toEqual({
    a: "a-result",
    b: "b-result",
  });

  expect(aCalls).toBe(1);
  expect((await runRow(db, "resumable-1"))?.status).toBe("completed");
  const events = await eventsFor(db, "resumable-1");
  expect(events.filter((e) => e.type === "run_started").length).toBe(2);
  expect(
    events.filter((e) => e.seq === 1 && e.type === "step_started").length,
  ).toBe(2);
});

test("resume failed run after a fix: only the killing step re-executes", async () => {
  const db = createTestDb();
  let aCalls = 0;
  let shouldFail = true;
  const stepA = defineStep("step-a", async () => {
    aCalls += 1;
    return "a-result";
  });
  const stepB = defineStep("step-b", async () => {
    if (shouldFail) throw new Error("transient");
    return "b-ok";
  });
  const wf = defineWorkflow("fixable", async (ctx) => {
    const a = await ctx.step(stepA, null);
    const b = await ctx.step(stepB, null);
    return `${a}/${b}`;
  });
  const engine = createEngine({ db, workflows: [wf] });

  const first = await engine.start(wf, null, { runId: "fix-1" });
  await expect(first.result()).rejects.toThrow("transient");
  expect((await runRow(db, "fix-1"))?.status).toBe("failed");

  shouldFail = false;
  const second = await engine.resume("fix-1");
  await expect(second.result()).resolves.toBe("a-result/b-ok");
  expect(aCalls).toBe(1);

  const bEvents = (await eventsFor(db, "fix-1"))
    .filter((e) => e.seq === 1)
    .map((e) => e.type);
  expect(bEvents).toEqual([
    "step_created",
    "step_started",
    "step_failed",
    "step_started",
    "step_completed",
  ]);
});

test("resume no-ops on completed/cancelled runs, throws on unknown/unregistered", async () => {
  const db = createTestDb();
  const ok = defineStep("ok", async () => "fine");
  const wf = defineWorkflow("noop-target", async (ctx) => ctx.step(ok, null));
  const engine = createEngine({ db, workflows: [wf] });

  const done = await engine.start(wf, null, { runId: "done-1" });
  await expect(done.result()).resolves.toBe("fine");
  const doneEvents = (await eventsFor(db, "done-1")).length;
  const resumedDone = await engine.resume("done-1");
  await expect(resumedDone.result()).resolves.toBe("fine");
  expect((await eventsFor(db, "done-1")).length).toBe(doneEvents);

  const gate = makeGate();
  const hang = defineStep("hang", async () => {
    if (!gate.isOpen()) return new Promise<string>(() => {});
    return "late";
  });
  const hangWf = defineWorkflow("hang-wf", async (ctx) => ctx.step(hang, null));
  const hung = await engine.start(hangWf, null, { runId: "gone-1" });
  await until(async () =>
    (await eventTypes(db, "gone-1")).includes("step_started"),
  );
  await engine.cancel("gone-1");
  await expect(hung.result()).rejects.toBeInstanceOf(WorkflowCancelledError);
  const goneEvents = (await eventsFor(db, "gone-1")).length;
  const resumedGone = await engine.resume("gone-1");
  await expect(resumedGone.result()).rejects.toBeInstanceOf(
    WorkflowCancelledError,
  );
  expect((await eventsFor(db, "gone-1")).length).toBe(goneEvents);

  await expect(engine.resume("no-such-run")).rejects.toThrow(/Unknown/);
  const bareEngine = createEngine({ db, workflows: [] });
  await expect(bareEngine.resume("done-1")).rejects.toThrow(/not registered/);
});

test("drift: resume with a renamed step at seq 0 fails with NonDeterminismError", async () => {
  const db = createTestDb();
  const gate = makeGate();
  const alpha = defineStep("alpha", async () => "x");
  const renamed = defineStep("renamed", async () => "x");
  const hang = defineStep("hang", async () => {
    if (!gate.isOpen()) return new Promise<string>(() => {});
    return "late";
  });
  const v1 = defineWorkflow("drifty", async (ctx) => {
    await ctx.step(alpha, null);
    await ctx.step(hang, null);
    return "done";
  });
  const v2 = defineWorkflow("drifty", async (ctx) => {
    await ctx.step(renamed, null);
    await ctx.step(hang, null);
    return "done";
  });

  const engine1 = createEngine({ db, workflows: [v1] });
  await engine1.start(v1, null, { runId: "drift-1" });
  await until(async () => (await stepRows(db, "drift-1")).length === 2);

  gate.open();
  const engine2 = createEngine({ db, workflows: [v2] });
  const handle = await engine2.resume("drift-1");
  await expect(handle.result()).rejects.toBeInstanceOf(NonDeterminismError);
  expect((await runRow(db, "drift-1"))?.status).toBe("failed");
});

test("concurrent resume in-process dedupes: one driver, step fns run once", async () => {
  const db = createTestDb();
  let aCalls = 0;
  let bCalls = 0;
  const gate = makeGate();
  const stepA = defineStep("step-a", async () => {
    aCalls += 1;
    return "a";
  });
  const stepB = defineStep("step-b", async () => {
    bCalls += 1;
    if (!gate.isOpen()) return new Promise<string>(() => {});
    return "b";
  });
  const wf = defineWorkflow("dedupe", async (ctx) => {
    const a = await ctx.step(stepA, null);
    const b = await ctx.step(stepB, null);
    return `${a}${b}`;
  });

  const engine1 = createEngine({ db, workflows: [wf] });
  await engine1.start(wf, null, { runId: "dedupe-1" });
  await until(async () => (await stepRows(db, "dedupe-1")).length === 2);

  gate.open();
  const engine2 = createEngine({ db, workflows: [wf] });
  const [h1, h2] = await Promise.all([
    engine2.resume("dedupe-1"),
    engine2.resume("dedupe-1"),
  ]);
  expect(h1).toBe(h2);
  await expect(h1.result()).resolves.toBe("ab");

  expect(aCalls).toBe(1); // memoized on resume
  expect(bCalls).toBe(2); // engine1's hung invocation + engine2's single retry
  const events = await eventsFor(db, "dedupe-1");
  expect(events.filter((e) => e.type === "run_started").length).toBe(2);
});
