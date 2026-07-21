#!/usr/bin/env bun
import { runAgentTUI } from "@ai-sdk/tui";
import { createApp } from "@wolli/core";
import type { Api } from "@wolli/core/api";
import { hc } from "hono/client";
import { createRunStreamTransport } from "./transport.ts";

const USAGE = `wolli

Usage:
  wolli hello   Call the api's hello route
  wolli agent   Chat with the assistant agent in an interactive session

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

const [command] = args;

switch (command) {
  case "hello": {
    const res = await client.hello.$get();
    console.log(JSON.stringify(await res.json(), null, 2));
    break;
  }
  case "agent": {
    await runAgentTUI({
      title: "wolli",
      transport: createRunStreamTransport(client),
    });
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
