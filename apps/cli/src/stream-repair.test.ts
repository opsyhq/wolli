import { expect, test } from "bun:test";
import { repairStreamFraming, type StreamChunk } from "./stream-repair.ts";

async function repair(chunks: StreamChunk[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of repairStreamFraming(
    (async function* () {
      yield* chunks;
    })(),
  )) {
    out.push(chunk);
  }
  return out;
}

const chunk = (value: unknown): StreamChunk => value as StreamChunk;

test("repair: a well-formed stream passes through unchanged", async () => {
  const stream = [
    chunk({ type: "step.started", seq: 0, name: "call-agent" }),
    chunk({ type: "start" }),
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "hi" }),
    chunk({ type: "text-end", id: "0" }),
    chunk({ type: "finish" }),
    chunk({ type: "step.completed", seq: 0 }),
  ];
  expect(await repair(stream)).toEqual(stream);
});

test("repair: drops duplicated starts and re-delivered chunks for ended parts", async () => {
  const out = await repair([
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "a" }),
    chunk({ type: "text-start", id: "0" }), // replayed duplicate
    chunk({ type: "text-delta", id: "0", delta: "b" }),
    chunk({ type: "text-end", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "stale" }), // after end
  ]);
  expect(out).toEqual([
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "a" }),
    chunk({ type: "text-delta", id: "0", delta: "b" }),
    chunk({ type: "text-end", id: "0" }),
  ]);
});

test("repair: synthesizes the missing start for a mid-part resume", async () => {
  // A startIndex resume that lands after the text-start.
  const out = await repair([
    chunk({ type: "text-delta", id: "0", delta: "tail" }),
    chunk({ type: "text-end", id: "0" }),
  ]);
  expect(out).toEqual([
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "tail" }),
    chunk({ type: "text-end", id: "0" }),
  ]);
});

test("repair: finish-step resets framing so the next step may reuse ids", async () => {
  const out = await repair([
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-end", id: "0" }),
    chunk({ type: "finish-step" }),
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "next" }),
  ]);
  expect(out.map((c) => c.type)).toEqual([
    "text-start",
    "text-end",
    "finish-step",
    "text-start",
    "text-delta",
  ]);
});

test("repair: a step restart closes the abandoned attempt's parts and reframes", async () => {
  const started = chunk({ type: "step.started", seq: 0, name: "call-agent" });
  const out = await repair([
    started,
    chunk({ type: "start" }),
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "partial" }), // attempt 1 dies here
    started, // restart boundary
    chunk({ type: "start" }),
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "full answer" }),
    chunk({ type: "text-end", id: "0" }),
  ]);
  expect(out).toEqual([
    started,
    chunk({ type: "start" }),
    chunk({ type: "text-start", id: "0" }),
    chunk({ type: "text-delta", id: "0", delta: "partial" }),
    chunk({ type: "text-end", id: "0" }), // synthesized close of the dead attempt
    started,
    chunk({ type: "start" }),
    chunk({ type: "text-start", id: "0" }), // allowed again: framing was reset
    chunk({ type: "text-delta", id: "0", delta: "full answer" }),
    chunk({ type: "text-end", id: "0" }),
  ]);
});
