#!/usr/bin/env node
/**
 * bin shim. Mirrors `@opsyhq/coding-agent`'s cli.ts: set the process title and
 * env, suppress Node process warnings, configure the HTTP dispatcher, then hand
 * off to `main`.
 *
 * Deviation from `@opsyhq/coding-agent`: pi's `main` calls `process.exit`
 * internally and invokes `main` bare. Steward's `main` instead returns a numeric
 * exit code, so this shim awaits it and sets `process.exitCode` (mapping a thrown
 * error to exit code 1).
 */

import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.STEWARD_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Deviation from `@opsyhq/coding-agent`: pi re-applies this from its
// SettingsManager once global/project settings load. Steward has no
// SettingsManager, so the default idle timeout is final.
configureHttpDispatcher();

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
