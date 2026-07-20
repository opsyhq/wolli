#!/usr/bin/env bun
import { type Api, api } from "@wolli/core/api";
import { hc } from "hono/client";

const USAGE = `wolli

Usage:
  wolli hello   Call the api's hello route

Options:
  --api-url <url>  Talk to a remote wolli server instead of running core
                   in-process (env: WOLLI_API_URL)`;

const args = Bun.argv.slice(2);
const flagAt = args.indexOf("--api-url");
const apiUrl =
  flagAt === -1 ? process.env.WOLLI_API_URL : args.splice(flagAt, 2)[1];

// The transport seam: remote mode is plain fetch against a served instance;
// local mode hands the client the in-process api's request handler, so the
// exact same routes run with no server involved.
const client = apiUrl
  ? hc<Api>(apiUrl)
  : hc<Api>("http://wolli.local", { fetch: api.request });

const [command] = args;

switch (command) {
  case "hello": {
    const res = await client.hello.$get();
    console.log(JSON.stringify(await res.json(), null, 2));
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
