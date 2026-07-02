/**
 * `list` — list agents with a one-line purpose summary. A pure read of the agents root; no daemon.
 */

import { APP_NAME, getAgentPurpose, Wolli } from "@opsyhq/wolli";

export function runList(): number {
	const agents = new Wolli().list();
	if (agents.length === 0) {
		console.log(`No agents yet. Create one with: ${APP_NAME} new <name>`);
		return 0;
	}
	for (const agent of agents) {
		const purpose = getAgentPurpose(agent.name);
		const summary = purpose.length > 72 ? `${purpose.slice(0, 69)}...` : purpose;
		console.log(`${agent.name}  —  ${summary}`);
	}
	return 0;
}
