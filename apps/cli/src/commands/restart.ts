/**
 * `restart <name>` — restart an agent's daemon so it picks up code changes, via `Agent.restart()`
 * (stop the running daemon, bring a fresh one up). Unlike the in-process `/reload`, this reloads the
 * daemon binary itself.
 */

import { APP_NAME, Wolli } from "@opsyhq/wolli";

export async function runRestart(positionals: string[]): Promise<number> {
	const wolli = new Wolli();
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} restart <name>\n`);
		return 1;
	}
	const agent = wolli.get(name);
	if (!agent) {
		process.stderr.write(`Unknown agent "${name}".\n`);
		return 1;
	}

	await agent.restart();
	console.log(`Restarted agent "${name}".`);
	return 0;
}
