import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";
import type { AgentInput } from "../agent/index.ts";
import type { Engine } from "../workflow/engine.ts";
import type { WorkflowDb } from "../workflow/schema.ts";
import { workflowRuns } from "../workflow/schema.ts";
import { readStream } from "../workflow/stream.ts";
import type { AnyWorkflow } from "../workflow/workflow.ts";

export interface CreateApiOptions {
  engine: Engine;
  db: WorkflowDb;
  /** Workflows startable over HTTP, addressed by name. */
  agents: AnyWorkflow[];
}

/**
 * Core's HTTP surface. Registration only — nothing here listens. Consumers
 * mount `api.fetch` in a server or call `api.request` in-process, and
 * `hc<Api>` gives a typed client over either.
 */
export function createApi({ engine, db, agents }: CreateApiOptions) {
  return (
    new Hono()
      .get("/hello", (c) => c.json({ message: "hello from @wolli/core" }))
      .post(
        "/agents/:name/runs",
        // Pass-through validator: gives hc's typed client the json body shape.
        validator("json", (body) => body as AgentInput),
        async (c) => {
          const name = c.req.param("name");
          const workflow = agents.find((w) => w.name === name);
          if (!workflow) {
            return c.json({ error: `Unknown agent "${name}"` }, 404);
          }
          const handle = await engine.start(workflow, c.req.valid("json"));
          return c.json({ runId: handle.runId }, 201);
        },
      )
      // SSE of the run's stream: replays chunks after `startIndex`, tails live,
      // ends with [DONE] at the eof row. Each SSE id is the reconnect cursor.
      .get("/runs/:id/stream", async (c) => {
        const runId = c.req.param("id");
        const run = (
          await db
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.id, runId))
            .limit(1)
        ).at(0);
        if (!run) return c.json({ error: `Unknown run "${runId}"` }, 404);
        const startIndex = Number(c.req.query("startIndex") ?? 0);
        return streamSSE(c, async (stream) => {
          for await (const chunk of readStream(db, runId, startIndex)) {
            if (stream.aborted) return;
            await stream.writeSSE({ id: String(chunk.id), data: chunk.data });
          }
          await stream.writeSSE({ data: "[DONE]" });
        });
      })
  );
}

export type Api = ReturnType<typeof createApi>;
