#!/usr/bin/env node
/**
 * bin shim: set the process title and env, suppress Node process warnings, configure the HTTP
 * dispatcher, then hand off to `main` (whose numeric return becomes `process.exitCode`).
 */

import { APP_NAME, configureHttpDispatcher } from "@opsyhq/wolli";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.WOLLI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
