import { Hono } from "hono";

/**
 * Core's HTTP surface. Registration only — nothing here listens. Consumers
 * mount `api.fetch` in a server or call `api.request` in-process, and
 * `hc<Api>` gives a typed client over either.
 */
export const api = new Hono().get("/hello", (c) =>
  c.json({ message: "hello from @wolli/core" }),
);

export type Api = typeof api;
