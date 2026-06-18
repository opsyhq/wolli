/**
 * `delete <name>` — type-the-name confirm, then tear the agent down.
 *
 * Order: uninstall the OS service (so a supervised daemon won't restart) and stop any daemon still
 * running, then delete the home dir, then drop the daemon config. `deleteAgent` operates solely on
 * the agent home — never the shared credential dir.
 */

import { createInterface } from "node:readline";
import {
	agentExists,
	APP_NAME,
	deleteAgent,
	deleteDaemonConfig,
	getAgentDir,
	getServiceManager,
	loadDaemonConfig,
} from "@opsyhq/steward";

export async function runDelete(positionals: string[]): Promise<number> {
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} delete <name>\n`);
		return 1;
	}
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}".\n`);
		return 1;
	}

	console.log(`This will delete agent "${name}" and all of its memory, sessions, and workspace:`);
	console.log(`  ${getAgentDir(name)}`);
	console.log(`Type ${name} to confirm:`);
	const answer = (await readLine("")).trim();
	if (answer !== name) {
		console.log("Delete cancelled.");
		return 1;
	}

	// Uninstall first (removes the OS unit so a supervised daemon won't relaunch), then stop any
	// daemon still running (a forming/birth daemon has no unit but is still a live process).
	getServiceManager().uninstall(name);
	stopRunningDaemon(name);

	const result = deleteAgent(name);
	if (!result.ok) {
		process.stderr.write(`Failed to delete agent "${name}": ${result.error ?? "unknown error"}\n`);
		return 1;
	}
	deleteDaemonConfig(name);
	console.log(`Deleted agent "${name}".`);
	return 0;
}

/** SIGTERM a live daemon so its signal handler shuts the server down (runDelete drops the config). */
function stopRunningDaemon(name: string): void {
	const config = loadDaemonConfig(name);
	if (!config) return;
	try {
		process.kill(config.pid, "SIGTERM");
	} catch {
		// Already gone.
	}
}

function readLine(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	return new Promise((resolve) => {
		// Resolve before close(): close() synchronously emits "close", whose handler would
		// otherwise resolve("") first and win.
		rl.once("line", (line) => {
			resolve(line);
			rl.close();
		});
		rl.once("close", () => resolve(""));
	});
}
