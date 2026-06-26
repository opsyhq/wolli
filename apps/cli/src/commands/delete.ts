/**
 * `delete <name>` — type-the-name confirm, then tear the agent down via `Agent.delete()` (uninstall
 * the OS service, shut down any running daemon, remove the home dir).
 */

import { createInterface } from "node:readline";
import { APP_NAME, getAgentDir, Steward } from "@opsyhq/steward";

export async function runDelete(positionals: string[]): Promise<number> {
	const steward = new Steward();
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} delete <name>\n`);
		return 1;
	}
	const agent = steward.get(name);
	if (!agent) {
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

	const result = await agent.delete();
	if (!result.ok) {
		process.stderr.write(`Failed to delete agent "${name}": ${result.error ?? "unknown error"}\n`);
		return 1;
	}
	console.log(`Deleted agent "${name}".`);
	return 0;
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
