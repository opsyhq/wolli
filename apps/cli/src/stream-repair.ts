import type { UIMessageChunk } from "@wolli/core";

/** Engine lifecycle events interleaved with ai-sdk chunks on the wire. */
export type StepStreamEvent =
  | { type: "step.started"; seq: number; name?: string }
  | { type: "step.completed"; seq: number }
  | { type: "step.failed"; seq: number };

export type StreamChunk = UIMessageChunk | StepStreamEvent;

/**
 * Tracks, for one part family (text or reasoning), which part ids are open or
 * ended within the current step.
 */
interface PartFrameState {
  /** A `*-start` was seen and not yet ended in the current step. */
  open: Set<string>;
  /** A part that was opened and ended in the current step. */
  ended: Set<string>;
}

const newPartFrameState = (): PartFrameState => ({
  open: new Set(),
  ended: new Set(),
});

/**
 * Repairs the framing for a single `*-start` / `*-delta` / `*-end` chunk
 * against the running per-step state, yielding the chunks the consumer should
 * see. Text and reasoning parts share this logic (`startType` differentiates
 * the synthesized start chunk).
 */
function* repairPart(
  kind: "start" | "delta" | "end",
  id: string,
  chunk: UIMessageChunk,
  state: PartFrameState,
  startType: "text-start" | "reasoning-start",
): Generator<UIMessageChunk> {
  if (kind === "start") {
    // Drop a duplicate/replayed start for a part already framed this step.
    if (state.open.has(id) || state.ended.has(id)) {
      return;
    }
    state.open.add(id);
    yield chunk;
    return;
  }

  // delta / end: drop a re-delivered chunk for an already-ended part.
  if (state.ended.has(id)) {
    return;
  }
  // Synthesize the missing start for an orphaned delta/end.
  if (!state.open.has(id)) {
    state.open.add(id);
    yield { type: startType, id } as UIMessageChunk;
  }
  if (kind === "end") {
    state.open.delete(id);
    state.ended.add(id);
  }
  yield chunk;
}

/**
 * Repairs the part framing of a run's chunk stream so it is always
 * well-formed for a rendering consumer.
 *
 * Port of @ai-sdk/workflow's `normalizeUIMessageStreamParts`: the durable
 * stream is append-only and steps run at-least-once, so a reader can see
 * duplicated or orphaned part chunks. Repairing the framing at read time
 * degrades the worst case to "text begins slightly into the step" instead of
 * a broken render:
 * - resets tracking on `finish-step` (where the ai-sdk consumer resets);
 * - synthesizes a missing `*-start` for an orphaned `*-delta`/`*-end`
 *   (e.g. a `startIndex` resume landing mid-part);
 * - drops a re-delivered `*-start`/`*-delta`/`*-end` for a part already
 *   open or ended in the current step (reconnect/replay overlap).
 *
 * One wolli addition on top of the port: a repeated `step.started` event for
 * a seq is a step re-execution boundary (the failed attempt's chunks stay in
 * the log as history). The abandoned attempt's open parts are closed with
 * synthesized `*-end` chunks and the framing state resets, so the aborted
 * partial and the fresh attempt render as separate, well-formed parts.
 *
 * A well-formed stream passes through unchanged.
 */
export async function* repairStreamFraming(
  source: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const text = newPartFrameState();
  const reasoning = newPartFrameState();
  const startedSeqs = new Set<number>();

  for await (const chunk of source) {
    switch (chunk.type) {
      case "finish-step":
        // The consumer clears its active-part maps here, so part ids may be
        // legitimately reused in the next step. Reset to match.
        text.open.clear();
        text.ended.clear();
        reasoning.open.clear();
        reasoning.ended.clear();
        yield chunk;
        break;

      case "text-start":
        yield* repairPart("start", chunk.id, chunk, text, "text-start");
        break;
      case "text-delta":
        yield* repairPart("delta", chunk.id, chunk, text, "text-start");
        break;
      case "text-end":
        yield* repairPart("end", chunk.id, chunk, text, "text-start");
        break;

      case "reasoning-start":
        yield* repairPart(
          "start",
          chunk.id,
          chunk,
          reasoning,
          "reasoning-start",
        );
        break;
      case "reasoning-delta":
        yield* repairPart(
          "delta",
          chunk.id,
          chunk,
          reasoning,
          "reasoning-start",
        );
        break;
      case "reasoning-end":
        yield* repairPart("end", chunk.id, chunk, reasoning, "reasoning-start");
        break;

      case "step.started": {
        if (startedSeqs.has(chunk.seq)) {
          // Step re-execution: close the abandoned attempt's open parts and
          // reset framing so the fresh attempt frames from scratch.
          for (const id of text.open) {
            yield { type: "text-end", id } as UIMessageChunk;
          }
          for (const id of reasoning.open) {
            yield { type: "reasoning-end", id } as UIMessageChunk;
          }
          text.open.clear();
          text.ended.clear();
          reasoning.open.clear();
          reasoning.ended.clear();
        }
        startedSeqs.add(chunk.seq);
        yield chunk;
        break;
      }

      default:
        yield chunk;
    }
  }
}
