/**
 * Heartbeat consumer — the reference extension that consumes an integration.
 *
 * Pairs with `examples/integrations/heartbeat.ts`. It subscribes to the heartbeat's
 * `tick` event and, on the first tick, invokes the `ping` action — persisting both
 * to the session as custom entries (no LLM turn is triggered).
 */

import type { ExtensionAPI } from "@opsyhq/steward";

export default function (steward: ExtensionAPI) {
	const hb = steward.getIntegration("heartbeat", "default");

	let pinged = false;
	hb.on("tick", async (data) => {
		steward.appendEntry("heartbeat_tick", data);
		if (!pinged) {
			pinged = true;
			steward.appendEntry("heartbeat_ping", await hb.call("ping"));
		}
	});
}
