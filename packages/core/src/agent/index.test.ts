import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool, type UIMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { z } from "zod";
import type { WorkflowDb } from "../workflow/index.ts";
import {
  createEngine,
  workflowSchema,
  workflowSteps,
  workflowStreamChunks,
} from "../workflow/index.ts";
import { defineAgent } from "./index.ts";

function createTestDb(): WorkflowDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema: workflowSchema });
  migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
  return db;
}

const stepRows = (db: WorkflowDb, runId: string) =>
  db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.runId, runId))
    .orderBy(asc(workflowSteps.seq));

const streamChunks = async (db: WorkflowDb, runId: string) =>
  (
    await db
      .select()
      .from(workflowStreamChunks)
      .where(eq(workflowStreamChunks.runId, runId))
      .orderBy(asc(workflowStreamChunks.id))
  )
    .filter((row) => !row.eof)
    // biome-ignore lint/suspicious/noExplicitAny: raw journal rows under test
    .map((row) => JSON.parse(row.data ?? "null") as any);

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

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const textResponse = (text: string) => ({
  stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage,
    },
  ]),
});

const toolCallResponse = (
  ...calls: { toolCallId: string; toolName: string; input: unknown }[]
) => ({
  stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
    { type: "stream-start", warnings: [] },
    ...calls.map(
      (call): LanguageModelV3StreamPart => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      }),
    ),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage,
    },
  ]),
});

const userMessages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
];

const echoTool = tool({
  description: "echo",
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
});

test("single turn without tools: two step rows, text output, framed stream", async () => {
  const db = createTestDb();
  const model = new MockLanguageModelV3({ doStream: [textResponse("Hello")] });
  const agent = defineAgent({ name: "solo", model, instructions: "test" });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({ text: "Hello" });

  const steps = await stepRows(db, handle.runId);
  expect(steps.map((s) => `${s.name}:${s.status}`)).toEqual([
    "solo:call-model:completed",
    "solo:finish-stream:completed",
  ]);

  const chunks = await streamChunks(db, handle.runId);
  const types = chunks.map((c) => c.type);
  // Clients key the assistant message on start's messageId — it must be the
  // run id so it is unique per turn and stable across replays.
  expect(chunks.filter((c) => c.type === "start")).toEqual([
    { type: "start", messageId: handle.runId },
  ]);
  expect(types.filter((t) => t === "finish")).toEqual(["finish"]);
  expect(types).toEqual([
    "step.started",
    "start",
    "start-step",
    "text-start",
    "text-delta",
    "text-end",
    "finish-step",
    "step.completed",
    "step.started",
    "finish",
    "step.completed",
  ]);
});

test("tool loop journaling: one step per model/tool call, wrapped result fed back", async () => {
  const db = createTestDb();
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse({
        toolCallId: "call-1",
        toolName: "echo",
        input: { value: "hi" },
      }),
      textResponse("Echoed: hi"),
    ],
  });
  const agent = defineAgent({
    name: "looper",
    model,
    tools: { echo: echoTool },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({ text: "Echoed: hi" });

  const steps = await stepRows(db, handle.runId);
  expect(steps.map((s) => s.name)).toEqual([
    "looper:call-model",
    "looper:run-tool",
    "looper:call-model",
    "looper:finish-stream",
  ]);
  expect(steps[1]?.params).toBe(
    JSON.stringify({
      toolCallId: "call-1",
      toolName: "echo",
      input: { value: "hi" },
    }),
  );

  expect(model.doStreamCalls.length).toBe(2);
  const toolMessage = model.doStreamCalls[1]?.prompt.find(
    (m) => m.role === "tool",
  );
  expect(toolMessage?.content).toEqual([
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "echo",
      output: { type: "json", value: { echoed: "hi" } },
    },
  ]);
});

test("parallel tool calls: run-tool rows in call order, one tool message with both results", async () => {
  const db = createTestDb();
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse(
        { toolCallId: "call-a", toolName: "echo", input: { value: "a" } },
        { toolCallId: "call-b", toolName: "echo", input: { value: "b" } },
      ),
      textResponse("both done"),
    ],
  });
  const agent = defineAgent({
    name: "fanout",
    model,
    tools: { echo: echoTool },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({ text: "both done" });

  const steps = await stepRows(db, handle.runId);
  expect(steps.map((s) => s.name)).toEqual([
    "fanout:call-model",
    "fanout:run-tool",
    "fanout:run-tool",
    "fanout:call-model",
    "fanout:finish-stream",
  ]);
  expect(JSON.parse(steps[1]?.params ?? "{}").toolCallId).toBe("call-a");
  expect(JSON.parse(steps[2]?.params ?? "{}").toolCallId).toBe("call-b");

  const toolMessages = model.doStreamCalls[1]?.prompt.filter(
    (m) => m.role === "tool",
  );
  expect(toolMessages?.length).toBe(1);
  expect(
    toolMessages?.[0]?.content
      .filter((part) => part.type === "tool-result")
      .map((part) => ({ id: part.toolCallId, output: part.output })),
  ).toEqual([
    { id: "call-a", output: { type: "json", value: { echoed: "a" } } },
    { id: "call-b", output: { type: "json", value: { echoed: "b" } } },
  ]);
});

test("persistent tool failure: 3 attempts, error-text fed to model, run completes", async () => {
  const db = createTestDb();
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse({
        toolCallId: "call-1",
        toolName: "broken",
        input: {},
      }),
      textResponse("tool failed, sorry"),
    ],
  });
  const agent = defineAgent({
    name: "brittle",
    model,
    tools: {
      broken: tool({
        description: "always fails",
        inputSchema: z.object({}),
        execute: async (): Promise<{ ok: boolean }> => {
          attempts += 1;
          throw new Error("kaput");
        },
      }),
    },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({
    text: "tool failed, sorry",
  });
  expect(attempts).toBe(3);

  const steps = await stepRows(db, handle.runId);
  expect(steps[1]?.name).toBe("brittle:run-tool");
  expect(steps[1]?.status).toBe("failed");
  expect(steps[1]?.attempts).toBe(3);

  const toolMessage = model.doStreamCalls[1]?.prompt.find(
    (m) => m.role === "tool",
  );
  const errorResult = toolMessage?.content[0];
  expect(
    errorResult?.type === "tool-result" ? errorResult.output : null,
  ).toEqual({ type: "error-text", value: "kaput" });

  const errorChunks = (await streamChunks(db, handle.runId)).filter(
    (c) => c.type === "tool-output-error",
  );
  expect(errorChunks.length).toBe(3);
  expect(errorChunks[0]?.errorText).toBe("kaput");
});

test("transient tool failure: succeeds on the second attempt", async () => {
  const db = createTestDb();
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse({ toolCallId: "call-1", toolName: "flaky", input: {} }),
      textResponse("recovered"),
    ],
  });
  const agent = defineAgent({
    name: "wobbly",
    model,
    tools: {
      flaky: tool({
        description: "fails once",
        inputSchema: z.object({}),
        execute: async () => {
          attempts += 1;
          if (attempts < 2) throw new Error("hiccup");
          return { ok: true };
        },
      }),
    },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({ text: "recovered" });
  expect(attempts).toBe(2);

  const steps = await stepRows(db, handle.runId);
  expect(steps[1]?.status).toBe("completed");
  expect(steps[1]?.attempts).toBe(2);

  const toolMessage = model.doStreamCalls[1]?.prompt.find(
    (m) => m.role === "tool",
  );
  const flakyResult = toolMessage?.content[0];
  expect(
    flakyResult?.type === "tool-result" ? flakyResult.output : null,
  ).toEqual({ type: "json", value: { ok: true } });
});

test("crash between model and tool steps: resume memoizes the model call", async () => {
  const db = createTestDb();
  let gateOpen = false;
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse({ toolCallId: "call-1", toolName: "slow", input: {} }),
      textResponse("resumed"),
    ],
  });
  const agent = defineAgent({
    name: "crashy",
    model,
    tools: {
      slow: tool({
        description: "hangs until the gate opens",
        inputSchema: z.object({}),
        execute: async () => {
          if (!gateOpen) return new Promise(() => {});
          return { late: true };
        },
      }),
    },
  });

  const engine1 = createEngine({ db, workflows: [agent] });
  await engine1.start(agent, { messages: userMessages }, { runId: "crash-1" });
  await until(async () => (await stepRows(db, "crash-1")).length === 2);
  expect(model.doStreamCalls.length).toBe(1);

  // "Crash": abandon engine1 mid-run-tool and resume on a fresh engine.
  gateOpen = true;
  const engine2 = createEngine({ db, workflows: [agent] });
  const handle = await engine2.resume("crash-1");
  await expect(handle.result()).resolves.toEqual({ text: "resumed" });

  // 2 conversation turns = 2 model calls total: the completed call-model
  // step replayed from the journal instead of re-issuing the first call.
  expect(model.doStreamCalls.length).toBe(2);
  const steps = await stepRows(db, "crash-1");
  expect(steps.map((s) => `${s.name}:${s.status}`)).toEqual([
    "crashy:call-model:completed",
    "crashy:run-tool:completed",
    "crashy:call-model:completed",
    "crashy:finish-stream:completed",
  ]);
});

test("stream sequence over a 2-turn run passes repairStreamFraming unchanged", async () => {
  const db = createTestDb();
  const model = new MockLanguageModelV3({
    doStream: [
      toolCallResponse({
        toolCallId: "call-1",
        toolName: "echo",
        input: { value: "hi" },
      }),
      textResponse("Echoed: hi"),
    ],
  });
  const agent = defineAgent({
    name: "framed",
    model,
    tools: { echo: echoTool },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await handle.result();

  const chunks = await streamChunks(db, handle.runId);
  expect(chunks.map((c) => c.type)).toEqual([
    "step.started", // call-model 0
    "start",
    "start-step",
    "tool-input-available",
    "finish-step",
    "step.completed",
    "step.started", // run-tool
    "tool-output-available",
    "step.completed",
    "step.started", // call-model 1
    "start-step",
    "text-start",
    "text-delta",
    "text-end",
    "finish-step",
    "step.completed",
    "step.started", // finish-stream
    "finish",
    "step.completed",
  ]);

  // A well-formed stream is repairStreamFraming's identity case.
  const { repairStreamFraming } = await import(
    "../../../../apps/cli/src/stream-repair.ts"
  );
  const repaired = [];
  for await (const chunk of repairStreamFraming(
    (async function* () {
      yield* chunks;
    })(),
  )) {
    repaired.push(chunk);
  }
  expect(repaired).toEqual(chunks);
});

test("iteration cap: 20 model calls, pending tools of the last call not executed", async () => {
  const db = createTestDb();
  let modelCalls = 0;
  let toolRuns = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      modelCalls += 1;
      return toolCallResponse({
        toolCallId: `call-${modelCalls}`,
        toolName: "echo",
        input: { value: `v${modelCalls}` },
      });
    },
  });
  const agent = defineAgent({
    name: "capped",
    model,
    tools: {
      echo: tool({
        description: "echo",
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => {
          toolRuns += 1;
          return { echoed: value };
        },
      }),
    },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  // The capped final response is all tool calls, no text.
  await expect(handle.result()).resolves.toEqual({ text: "" });

  expect(modelCalls).toBe(20);
  expect(toolRuns).toBe(19);
  const steps = await stepRows(db, handle.runId);
  const names = steps.map((s) => s.name);
  expect(names.filter((n) => n === "capped:call-model").length).toBe(20);
  expect(names.filter((n) => n === "capped:run-tool").length).toBe(19);
  expect(names.at(-1)).toBe("capped:finish-stream");
  expect((await streamChunks(db, handle.runId)).at(-2)?.type).toBe("finish");
});

test("reasoning parts and providerOptions survive the journal into the next prompt", async () => {
  const db = createTestDb();
  const model = new MockLanguageModelV3({
    doStream: [
      {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          {
            type: "reasoning-start",
            id: "r1",
            providerMetadata: { mock: { signature: "abc123" } },
          },
          { type: "reasoning-delta", id: "r1", delta: "thinking..." },
          { type: "reasoning-end", id: "r1" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "echo",
            input: JSON.stringify({ value: "hi" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage,
          },
        ]),
      },
      textResponse("done"),
    ],
  });
  const agent = defineAgent({
    name: "thinker",
    model,
    tools: { echo: echoTool },
  });
  const engine = createEngine({ db, workflows: [agent] });

  const handle = await engine.start(agent, { messages: userMessages });
  await expect(handle.result()).resolves.toEqual({ text: "done" });

  const assistant = model.doStreamCalls[1]?.prompt.find(
    (m) => m.role === "assistant",
  );
  expect(assistant?.content).toContainEqual({
    type: "reasoning",
    text: "thinking...",
    providerOptions: { mock: { signature: "abc123" } },
  });
});
