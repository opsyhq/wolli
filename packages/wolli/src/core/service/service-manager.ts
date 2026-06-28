/**
 * OS service backend — keeps a deployed agent's daemon always-on and boot-persistent. One loopback
 * daemon per agent, keyed by agent name: `launchd` (darwin) / `systemd --user` (linux) / `none`
 * (the unsupported-OS fallback). The unit runs the same `daemon <name>` subcommand a client spawns.
 */

import {
	ENV_DAEMON_HOST,
	ENV_DAEMON_TOKEN,
	ENV_HOME,
	ENV_SERVICE_MANAGER,
	ENV_SHARED_AGENT_DIR,
} from "../../config.ts";
import { LaunchdServiceManager } from "./launchd.ts";
import { NoneServiceManager } from "./none.ts";
import { SystemdServiceManager } from "./systemd.ts";

export type ServiceKind = "launchd" | "systemd" | "none";

export interface ServiceManager {
	readonly kind: ServiceKind;
	/** Write + load the OS unit (KeepAlive/RunAtLoad) so the agent's daemon is always-on, boot-persistent. */
	install(name: string): void;
	/** Stop + remove the OS unit. Best-effort; safe when nothing is installed. */
	uninstall(name: string): void;
	/** Ensure the installed service is running. */
	start(name: string): void;
	/** Stop the running service without removing its unit. */
	stop(name: string): void;
	/** Whether the service's daemon is loaded/active. (`none` probes `/health`, hence async.) */
	isRunning(name: string): Promise<boolean>;
}

/** Pick a backend from the platform, honoring the `WOLLI_SERVICE_MANAGER` override. */
export function detectServiceManager(): ServiceKind {
	const override = process.env[ENV_SERVICE_MANAGER]?.trim();
	if (override === "none" || override === "launchd" || override === "systemd") return override;
	if (process.platform === "darwin") return "launchd";
	if (process.platform === "linux") return "systemd";
	return "none";
}

/** Factory for the active service backend (defaults to `detectServiceManager()`). */
export function getServiceManager(kind: ServiceKind = detectServiceManager()): ServiceManager {
	switch (kind) {
		case "launchd":
			return new LaunchdServiceManager();
		case "systemd":
			return new SystemdServiceManager();
		default:
			return new NoneServiceManager();
	}
}

/**
 * The command the OS unit runs: the current node binary + this CLI's entry + `daemon <name>`.
 * Resolved from `process.execPath` + `process.argv[1]` — both point at the running `wolli` CLI
 * inside the daemon that installs. No port: the supervised daemon reads its fixed port from agent.json.
 */
export function daemonLaunchCommand(name: string): string[] {
	return [process.execPath, process.argv[1], "daemon", name];
}

/** The subset of env the service inherits so it resolves the same homes/credentials/bind host as the installer. */
export function serviceEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of [ENV_HOME, ENV_SHARED_AGENT_DIR, ENV_DAEMON_TOKEN, ENV_DAEMON_HOST]) {
		const value = process.env[key];
		if (value) environment[key] = value;
	}
	return environment;
}
