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
  const assistant = defineAgent({
    name: "assistant",
    model: process.env.WOLLI_MODEL ?? "anthropic/claude-sonnet-4-6",
    instructions: "You are wolli, a helpful assistant.",
  });
  const db = openDb(process.env.WOLLI_DB ?? "wolli.db");
  const engine = createEngine({ db, workflows: [assistant] });
  return { api: createApi({ engine, db, agents: [assistant] }), engine, db };
}
