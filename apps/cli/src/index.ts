#!/usr/bin/env bun
import { createApp } from "@wolli/core";
import type { Api } from "@wolli/core/api";
import { hc } from "hono/client";
import { repairStreamFraming, type StreamChunk } from "./stream-repair.ts";

const USAGE = `wolli

Usage:
  wolli hello            Call the api's hello route
  wolli agent <prompt>   Run the assistant agent, streaming its output

Options:
  --api-url <url>  Talk to a remote wolli server instead of running core
                   in-process (env: WOLLI_API_URL)`;

const args = Bun.argv.slice(2);
const flagAt = args.indexOf("--api-url");
const apiUrl =
  flagAt === -1 ? process.env.WOLLI_API_URL : args.splice(flagAt, 2)[1];

// The transport seam: remote mode is plain fetch against a served instance;
// local mode hands the client the in-process api's request handler, so the
// exact same routes run with no server involved. Every command goes through
// this one typed client.
const client = apiUrl
  ? hc<Api>(apiUrl)
  : hc<Api>("http://wolli.local", { fetch: createApp().api.request });

function printChunk(chunk: StreamChunk): void {
  if (chunk.type === "text-delta") process.stdout.write(chunk.delta);
  else if (chunk.type === "tool-input-available")
    console.log(`\n[tool call] ${chunk.toolName}`);
  else if (chunk.type === "error")
    console.error(`\n[error] ${chunk.errorText}`);
  else if (chunk.type === "finish") process.stdout.write("\n");
}

/** Decodes the SSE wire format into the chunk objects the api streamed. */
async function* readSseChunks(
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

const [command] = args;

switch (command) {
  case "hello": {
    const res = await client.hello.$get();
    console.log(JSON.stringify(await res.json(), null, 2));
    break;
  }
  case "agent": {
    const prompt = args[1];
    if (!prompt) {
      console.error(`Missing prompt\n\n${USAGE}`);
      process.exit(1);
    }
    const started = await client.agents[":name"].runs.$post({
      param: { name: "assistant" },
      json: {
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: prompt }] },
        ],
      },
    });
    if (started.status !== 201) {
      console.error(
        `start failed (${started.status}): ${await started.text()}`,
      );
      process.exit(1);
    }
    const { runId } = (await started.json()) as { runId: string };
    console.error(`run ${runId}`);
    const stream = await client.runs[":id"].stream.$get({
      param: { id: runId },
    });
    if (!stream.ok || !stream.body) {
      console.error(`stream failed (${stream.status})`);
      process.exit(1);
    }
    for await (const chunk of repairStreamFraming(readSseChunks(stream.body))) {
      printChunk(chunk);
    }
    break;
  }
  case undefined:
  case "help": {
    console.log(USAGE);
    break;
  }
  default: {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    process.exit(1);
  }
}
