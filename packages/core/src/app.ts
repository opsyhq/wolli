import { azure } from "@ai-sdk/azure";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "./agent/index.ts";
import { type Api, createApi } from "./api/index.ts";
import { openDb } from "./db.ts";
import type { Engine } from "./workflow/engine.ts";
import { createEngine } from "./workflow/engine.ts";
import type { WorkflowDb } from "./workflow/schema.ts";

/**
 * Builds core's default in-process stack — db, engine, default assistant
 * agent, api — from env config (WOLLI_DB, WOLLI_MODEL). The server mounts
 * `api.fetch`; the cli calls `api.request` directly.
 */
export function createApp(): { api: Api; engine: Engine; db: WorkflowDb } {
  // Azure OpenAI; env: AZURE_API_KEY + AZURE_RESOURCE_NAME.
  const assistant = defineAgent({
    name: "assistant",
    model: azure("gpt-5.5"),
    instructions: "You are wolli, a helpful assistant.",
    tools: {
      get_current_time: tool({
        description: "Get the current date and time.",
        inputSchema: z.object({}),
        execute: async () => ({ iso: new Date().toISOString() }),
      }),
    },
  });
  const db = openDb(process.env.WOLLI_DB ?? "wolli.db");
  const engine = createEngine({ db, workflows: [assistant] });
  return { api: createApi({ engine, db, agents: [assistant] }), engine, db };
}
