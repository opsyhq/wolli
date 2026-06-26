/**
 * `new <name>` — create an agent, then drop into its birth conversation.
 *
 * Creates the home tree (allocating the agent's fixed port + token into agent.json), then opens a
 * daemon client and runs the interactive birth session seeded with the opener. Birth is daemon-first:
 * abandoning a forming agent leaves only a detached daemon that idles out — no OS service unit (those
 * land only at deploy). The daemon binds the fixed port from agent.json.
 */

import { APP_NAME, Steward } from "@opsyhq/steward";
import { App, BIRTH_OPENER } from "../modes/interactive/app.ts";

export async function runNew(positionals: string[]): Promise<number> {
	const steward = new Steward();
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} new <name>\n`);
		return 1;
	}
	if (steward.get(name)) {
		process.stderr.write(`Agent "${name}" already exists.\n`);
		return 1;
	}

	// `create` throws on an invalid name; cli.ts's top-level handler prints the message and exits 1
	// (identical to a local catch), and `agent.connect()` already bubbles there — so no local try/catch.
	const agent = steward.create(name);
	process.stdout.write(`Created agent "${agent.config.name}".\n`);

	// Drop into the birth chat (seeded with the opener). App opens the daemon session for the route.
	const app = new App(steward);
	await app.start({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
	return 0;
}
