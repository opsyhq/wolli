/** systemd backend (Linux) — a `systemctl --user` unit (Restart=always) enabled into default.target. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_NAME, getAgentDir } from "../../config.ts";
import { daemonLaunchCommand, type ServiceManager, serviceEnvironment } from "./service-manager.ts";

/** systemd unit name for an agent, e.g. `wolli-scribe.service`. */
export function systemdUnitName(name: string): string {
	return `${APP_NAME}-${name}.service`;
}

function unitPath(name: string): string {
	return join(homedir(), ".config", "systemd", "user", systemdUnitName(name));
}

/** Quote a single ExecStart token (systemd splits on whitespace; double-quotes preserve paths). */
function quote(token: string): string {
	return /[\s"'\\]/.test(token) ? `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : token;
}

export interface SystemdUnitOptions {
	description: string;
	execStart: string[];
	workingDirectory: string;
	environment: Record<string, string>;
}

/** Render a `systemctl --user` service unit (Restart=always → always-on). Pure. */
export function buildSystemdUnit(options: SystemdUnitOptions): string {
	const envLines = Object.entries(options.environment)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");
	return `[Unit]
Description=${options.description}
After=network.target

[Service]
Type=simple
ExecStart=${options.execStart.map(quote).join(" ")}
WorkingDirectory=${options.workingDirectory}
Restart=always
RestartSec=2
${envLines ? `${envLines}\n` : ""}
[Install]
WantedBy=default.target
`;
}

export class SystemdServiceManager implements ServiceManager {
	readonly kind = "systemd" as const;

	private userctl(args: string[]) {
		return spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8" });
	}

	install(name: string): void {
		// Write + enable the unit for boot (no `--now`); `start` runs it. Split so the caller controls
		// when it runs.
		const unit = buildSystemdUnit({
			description: `${APP_NAME} agent "${name}" daemon`,
			execStart: daemonLaunchCommand(name),
			workingDirectory: getAgentDir(name),
			environment: serviceEnvironment(),
		});
		mkdirSync(dirname(unitPath(name)), { recursive: true });
		// Owner-only: the unit can carry the daemon bearer token via Environment=.
		writeFileSync(unitPath(name), unit, { encoding: "utf-8", mode: 0o600 });

		this.userctl(["daemon-reload"]);
		const result = this.userctl(["enable", systemdUnitName(name)]);
		if (result.status !== 0) {
			throw new Error(
				`systemctl --user enable failed for "${name}": ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
			);
		}
	}

	uninstall(name: string): void {
		this.userctl(["disable", "--now", systemdUnitName(name)]);
		rmSync(unitPath(name), { force: true });
		this.userctl(["daemon-reload"]);
	}

	start(name: string): void {
		// Enable + run now (and on boot).
		const result = this.userctl(["enable", "--now", systemdUnitName(name)]);
		if (result.status !== 0) {
			throw new Error(
				`systemctl --user enable --now failed for "${name}": ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
			);
		}
	}

	stop(name: string): void {
		this.userctl(["stop", systemdUnitName(name)]);
	}

	async isRunning(name: string): Promise<boolean> {
		if (!existsSync(unitPath(name))) return false;
		return this.userctl(["is-active", "--quiet", systemdUnitName(name)]).status === 0;
	}
}
