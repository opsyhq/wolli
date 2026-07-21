import type { Api } from "@wolli/core/api";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { hc } from "hono/client";
import { repairStreamFraming, type StreamChunk } from "./stream-repair.ts";

type ApiClient = ReturnType<typeof hc<Api>>;

/** Decodes the SSE wire format into the chunk objects the api streamed. */
export async function* readSseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data === "[DONE]") return;
      if (data) yield JSON.parse(data) as StreamChunk;
    }
  }
}

/**
 * ChatTransport over the run-stream api: each turn starts a new run with the
 * full accumulated history (stateless server) and streams it back. The engine
 * lifecycle `step.*` events feed repairStreamFraming's re-execution detection
 * and are dropped afterwards — the TUI only understands ai-sdk chunks.
 */
export function createRunStreamTransport(
  client: ApiClient,
): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages }) {
      const started = await client.agents[":name"].runs.$post({
        param: { name: "assistant" },
        json: { messages },
      });
      if (started.status !== 201) {
        throw new Error(
          `start failed (${started.status}): ${await started.text()}`,
        );
      }
      const { runId } = (await started.json()) as { runId: string };
      const stream = await client.runs[":id"].stream.$get({
        param: { id: runId },
      });
      if (!stream.ok || !stream.body) {
        throw new Error(`stream failed (${stream.status})`);
      }
      const repaired = repairStreamFraming(readSseChunks(stream.body));
      return new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          for (;;) {
            const { done, value } = await repaired.next();
            if (done) {
              controller.close();
              return;
            }
            if (value.type.startsWith("step.")) continue;
            controller.enqueue(value as UIMessageChunk);
            return;
          }
        },
        cancel() {
          void repaired.return(undefined);
        },
      });
    },
    reconnectToStream: async () => null,
  };
}
