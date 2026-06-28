/** launchd backend (macOS) — a per-user LaunchAgent plist (RunAtLoad + KeepAlive) loaded via `launchctl bootstrap gui/$UID`. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_NAME, getAgentDir, getDaemonRuntimeDir } from "../../config.ts";
import { daemonLaunchCommand, type ServiceManager, serviceEnvironment } from "./service-manager.ts";

/** Reverse-DNS label launchd keys the agent by, e.g. `com.wolli.scribe`. */
export function launchAgentLabel(name: string): string {
	return `com.${APP_NAME}.${name}`;
}

function plistPath(name: string): string {
	return join(homedir(), "Library", "LaunchAgents", `${launchAgentLabel(name)}.plist`);
}

/** The per-user GUI domain target, `gui/$UID` (the daemon is a loopback user agent). */
function domainTarget(): string {
	return `gui/${process.getuid?.() ?? 0}`;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface LaunchAgentPlistOptions {
	label: string;
	programArguments: string[];
	workingDirectory: string;
	stdoutPath: string;
	stderrPath: string;
	environment: Record<string, string>;
}

/** Render a LaunchAgent plist (RunAtLoad + KeepAlive → always-on, boot-persistent). Pure. */
export function buildLaunchAgentPlist(options: LaunchAgentPlistOptions): string {
	const argsXml = options.programArguments.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n");
	const envEntries = Object.entries(options.environment);
	const envXml = envEntries.length
		? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries
				.map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>`)
				.join("\n")}\n\t</dict>\n`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(options.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(options.workingDirectory)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(options.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(options.stderrPath)}</string>
${envXml}</dict>
</plist>
`;
}

export class LaunchdServiceManager implements ServiceManager {
	readonly kind = "launchd" as const;

	install(name: string): void {
		// Write the plist; `start` bootstraps it. (Split so the caller controls when it runs.)
		const plist = buildLaunchAgentPlist({
			label: launchAgentLabel(name),
			programArguments: daemonLaunchCommand(name),
			workingDirectory: getAgentDir(name),
			stdoutPath: join(getDaemonRuntimeDir(), `${name}.out.log`),
			stderrPath: join(getDaemonRuntimeDir(), `${name}.err.log`),
			environment: serviceEnvironment(),
		});
		mkdirSync(dirname(plistPath(name)), { recursive: true });
		mkdirSync(getDaemonRuntimeDir(), { recursive: true });
		// Owner-only: the plist can carry the daemon bearer token via EnvironmentVariables.
		writeFileSync(plistPath(name), plist, { encoding: "utf-8", mode: 0o600 });
	}

	uninstall(name: string): void {
		spawnSync("launchctl", ["bootout", `${domainTarget()}/${launchAgentLabel(name)}`], { encoding: "utf-8" });
		rmSync(plistPath(name), { force: true });
	}

	start(name: string): void {
		// Bootstrap the plist so launchd runs it now (and keeps it alive).
		const result = spawnSync("launchctl", ["bootstrap", domainTarget(), plistPath(name)], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(
				`launchctl bootstrap failed for "${name}": ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
			);
		}
	}

	stop(name: string): void {
		// A KeepAlive job can't be paused in place — booting it out is the clean stop; install reloads it.
		spawnSync("launchctl", ["bootout", `${domainTarget()}/${launchAgentLabel(name)}`], { encoding: "utf-8" });
	}

	async isRunning(name: string): Promise<boolean> {
		if (!existsSync(plistPath(name))) return false;
		const result = spawnSync("launchctl", ["print", `${domainTarget()}/${launchAgentLabel(name)}`], {
			encoding: "utf-8",
		});
		return result.status === 0;
	}
}
