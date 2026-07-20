import { createApp } from "@wolli/core";

const { api } = createApp();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: api.fetch,
});

console.log(`wolli api listening on ${server.url}`);
