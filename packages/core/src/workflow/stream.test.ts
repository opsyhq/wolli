import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { StreamChunkRow, WorkflowDb } from "./index.ts";
import {
  createEngine,
  defineStep,
  defineWorkflow,
  readStream,
  workflowSchema,
} from "./index.ts";

function createTestDb(): WorkflowDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema: workflowSchema });
  migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
  return db;
}

interface TestChunk {
  type: string;
  seq?: number;
  data?: { n?: number; attempt?: number };
}

async function collectChunks(
  db: WorkflowDb,
  runId: string,
  startIndex = 0,
): Promise<TestChunk[]> {
  const chunks: TestChunk[] = [];
  for await (const row of readStream(db, runId, startIndex)) {
    chunks.push(JSON.parse(row.data) as TestChunk);
  }
  return chunks;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
}

test("stream: live tail, eof on completion, identical replay", async () => {
  const db = createTestDb();
  const gate = Promise.withResolvers<void>();
  const emitTwice = defineStep("emit-twice", async (_: null, step) => {
    await step.emitChunk({ type: "data-test", data: { n: 1 } });
    await gate.promise;
    await step.emitChunk({ type: "data-test", data: { n: 2 } });
    return "done";
  });
  const streamy = defineWorkflow("streamy", (ctx, input: null) =>
    ctx.step(emitTwice, input),
  );
  const engine = createEngine({ db, workflows: [streamy] });
  const handle = await engine.start(streamy, null);

  const seen: TestChunk[] = [];
  const reader = (async () => {
    for await (const row of readStream(db, handle.runId)) {
      seen.push(JSON.parse(row.data) as TestChunk);
    }
  })();

  // chunk 1 reaches the tail while the step is still mid-flight
  await until(() => seen.some((c) => c.data?.n === 1));
  expect(seen.some((c) => c.data?.n === 2)).toBe(false);

  gate.resolve();
  await handle.result();
  await reader; // the eof row ends the tail

  const labels = seen.map((c) =>
    c.type.startsWith("step.") ? c.type : c.data?.n,
  );
  expect(labels).toEqual(["step.started", 1, 2, "step.completed"]);

  // a late reader replays the identical stream and also terminates
  expect(await collectChunks(db, handle.runId)).toEqual(seen);
});

test("stream: reconnect with startIndex resumes after the cursor", async () => {
  const db = createTestDb();
  const emitTwice = defineStep("emit-twice", async (_: null, step) => {
    await step.emitChunk({ type: "data-test", data: { n: 1 } });
    await step.emitChunk({ type: "data-test", data: { n: 2 } });
    return "done";
  });
  const streamy = defineWorkflow("streamy", (ctx, input: null) =>
    ctx.step(emitTwice, input),
  );
  const engine = createEngine({ db, workflows: [streamy] });
  const handle = await engine.start(streamy, null);
  await handle.result();

  const rows: StreamChunkRow[] = [];
  for await (const row of readStream(db, handle.runId)) rows.push(row);
  expect(rows.length).toBe(4);

  const cursor = rows[1];
  if (!cursor) throw new Error("expected a second chunk");
  const rest: StreamChunkRow[] = [];
  for await (const row of readStream(db, handle.runId, cursor.id)) {
    rest.push(row);
  }
  expect(rest).toEqual(rows.slice(2));
});

test("stream: the log is append-only — a failed attempt stays as history behind a restart boundary", async () => {
  const db = createTestDb();
  let attempts = 0;
  const flaky = defineStep(
    "flaky",
    async (_: null, step) => {
      attempts += 1;
      await step.emitChunk({ type: "data-test", data: { attempt: attempts } });
      if (attempts === 1) throw new Error("boom");
      return attempts;
    },
    { maxAttempts: 2, initialDelayMs: 1 },
  );
  const streamy = defineWorkflow("streamy", (ctx, input: null) =>
    ctx.step(flaky, input),
  );
  const engine = createEngine({ db, workflows: [streamy] });
  const handle = await engine.start(streamy, null);
  await handle.result();

  const chunks = await collectChunks(db, handle.runId);
  // Both attempts are preserved; the repeated step.started is the restart
  // boundary read-side repair keys on.
  const attemptsSeen = chunks
    .filter((c) => c.type === "data-test")
    .map((c) => c.data?.attempt);
  expect(attemptsSeen).toEqual([1, 2]);
  const events = chunks
    .filter((c) => c.type.startsWith("step."))
    .map((c) => c.type);
  expect(events).toEqual(["step.started", "step.started", "step.completed"]);
});
