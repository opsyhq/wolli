/**
 * `new <name>` — create an agent and print how to start chatting with it.
 *
 * Creates the home tree (allocating the agent's fixed port + token into agent.json) and provisions
 * the OS service unit — the agent's daemon is always-on from creation (with the `none` backend a
 * detached daemon spawns on attach instead). Then prints a confirmation and exits without attaching;
 * `wolli <name>` opens the chat. (The interactive `wolli` dashboard is the create-and-chat path, and
 * it seeds the birth opener when it routes into the new agent's chat.)
 */

import { APP_NAME, Wolli } from "@opsyhq/wolli";
import chalk from "chalk";

export async function runNew(positionals: string[]): Promise<number> {
	const wolli = new Wolli();
	const name = positionals[0];
	if (!name || positionals.length > 1) {
		process.stderr.write(`Usage: ${APP_NAME} new <name>\n`);
		return 1;
	}
	if (wolli.get(name)) {
		process.stderr.write(`Agent "${name}" already exists.\n`);
		return 1;
	}

	// `create` throws on an invalid name; cli.ts's top-level handler prints the message and exits 1.
	const agent = await wolli.create(name);
	console.log(chalk.green(`Created agent "${agent.config.name}".`));
	console.log(`${chalk.dim("Type")} ${chalk.bold(`${APP_NAME} ${agent.name}`)} ${chalk.dim("to chat with it")}`);
	return 0;
}
