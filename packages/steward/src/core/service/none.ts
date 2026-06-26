/**
 * none backend — the unsupported-OS fallback (no launchd/systemd). There is no supervisor, so
 * `install`/`start` are inert: the daemon that handled deploy keeps running for this session, and a
 * client re-spawns one on demand (`Agent.connect`) rather than the backend supervising it.
 * `stop`/`isRunning` act on the agent's fixed port (from agent.json): a `/health` probe for liveness,
 * a `shutdown` request to stop.
 */

import { isHealthy, requestDaemonShutdown } from "../../client.ts";
import { getDaemonHost, getDaemonToken } from "../../config.ts";
import { AgentSettingsManager } from "../agent-settings-manager.ts";
import type { ServiceManager } from "./service-manager.ts";

export class NoneServiceManager implements ServiceManager {
	readonly kind = "none" as const;

	install(_name: string): void {
		// No OS supervisor to register with — the already-running daemon serves the session.
	}

	uninstall(_name: string): void {
		// Nothing was registered.
	}

	start(_name: string): void {
		// No supervisor to start; the daemon lifecycle is the client's (Agent.connect) concern.
	}

	stop(name: string): void {
		const store = AgentSettingsManager.get(name);
		if (!store) return;
		void requestDaemonShutdown(
			`http://${getDaemonHost()}:${store.config.port}`,
			getDaemonToken() || store.config.token,
		);
	}

	async isRunning(name: string): Promise<boolean> {
		const store = AgentSettingsManager.get(name);
		if (!store) return false;
		return isHealthy(`http://${getDaemonHost()}:${store.config.port}`);
	}
}
