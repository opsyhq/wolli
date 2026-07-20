import { and, asc, eq, gt } from "drizzle-orm";
import type { WorkflowDb } from "./schema.ts";
import { workflowStreamChunks } from "./schema.ts";

/**
 * In-process wake registry for stream tails. v1 is single-process — the
 * writer and every reader share this map, so a tail wakes on the next chunk
 * without polling. The bounded wait in readStream is the fallback for rows
 * written outside this registry's sight (e.g. a future second process).
 */
const wakers = new Map<string, Set<() => void>>();

export function wakeStreamReaders(runId: string): void {
  const waiting = wakers.get(runId);
  if (!waiting) return;
  wakers.delete(runId);
  for (const wake of waiting) wake();
}

function waitForChunk(runId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let waiting = wakers.get(runId);
    if (!waiting) {
      waiting = new Set();
      wakers.set(runId, waiting);
    }
    const wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiting.delete(wake);
      resolve();
    }, timeoutMs);
    waiting.add(wake);
  });
}

/** Appends one chunk to a run's stream and wakes its tails. */
export async function writeStreamChunk(
  db: WorkflowDb,
  runId: string,
  stepSeq: number,
  chunk: unknown,
): Promise<void> {
  await db.insert(workflowStreamChunks).values({
    runId,
    streamId: runId,
    stepSeq,
    data: JSON.stringify(chunk) ?? "null",
  });
  wakeStreamReaders(runId);
}

export interface StreamChunkRow {
  /** Reconnect cursor: pass as `startIndex` to resume after this chunk. */
  id: number;
  /** The chunk as it was written, JSON text. */
  data: string;
}

/**
 * Reads a run's stream from `startIndex` (exclusive): replays stored chunks,
 * then tails live until the eof row. Every reader is an independent cursor,
 * so concurrent readers and reconnects need no coordination.
 */
export async function* readStream(
  db: WorkflowDb,
  runId: string,
  startIndex = 0,
): AsyncGenerator<StreamChunkRow> {
  let cursor = startIndex;
  while (true) {
    const rows = await db
      .select()
      .from(workflowStreamChunks)
      .where(
        and(
          eq(workflowStreamChunks.runId, runId),
          gt(workflowStreamChunks.id, cursor),
        ),
      )
      .orderBy(asc(workflowStreamChunks.id));
    for (const row of rows) {
      if (row.eof) return;
      cursor = row.id;
      yield { id: row.id, data: row.data ?? "null" };
    }
    if (rows.length === 0) await waitForChunk(runId, 500);
  }
}
