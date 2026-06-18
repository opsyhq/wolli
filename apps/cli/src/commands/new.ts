/**
 * `new <name>` — create an agent, then drop into its birth conversation.
 *
 * Creates the home tree, then opens a daemon client and runs the interactive birth session seeded
 * with the opener. Birth is daemon-first: abandoning a forming agent leaves only a temp daemon
 * config + a detached daemon that idles out — no OS service unit (those land only at deploy). The
 * daemon binds an OS-assigned ephemeral port and writes it to the temp config; clients discover it
 * there, so no port is reserved up front.
 */

import { agentExists, APP_NAME, createAgent } from "@opsyhq/steward";
import { DaemonSession } from "../daemon-session.ts";
import { InteractiveMode } from "../modes/interactive/interactive-mode.ts";

// A newly born agent opens the chat itself, asking its human what it is for.
const BIRTH_OPENER = "What is my purpose?";

export async function runNew(positionals: string[], model?: string): Promise<number> {
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} new <name>\n`);
		return 1;
	}
	if (agentExists(name)) {
		process.stderr.write(`Agent "${name}" already exists.\n`);
		return 1;
	}

	try {
		const config = createAgent({ name, model });
		process.stdout.write(`Created agent "${config.name}".\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	const session = await DaemonSession.open(name);
	await new InteractiveMode(session, { initialAssistantMessage: BIRTH_OPENER }).run();
	return 0;
}
