#!/usr/bin/env node
/**
 * bin shim. Mirrors `@opsyhq/coding-agent`'s cli.ts: set the process title, then
 * hand off to `main`. Exit code comes back from `main` (which returns a number)
 * rather than `process.exit` calls scattered through it.
 */

import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
