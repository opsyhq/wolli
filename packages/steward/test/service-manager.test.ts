/**
 * OS service backend — detection override, the factory, the pure plist/unit builders, the launch
 * command, and the `none` backend's config-driven liveness. The launchd/systemd backends'
 * real `launchctl`/`systemctl` wiring is exercised by the live verify, not here (a unit test must
 * not register a real OS service).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_SERVICE_MANAGER } from "../src/config.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { buildLaunchAgentPlist, launchAgentLabel } from "../src/core/service/launchd.ts";
import { daemonLaunchCommand, detectServiceManager, getServiceManager } from "../src/core/service/service-manager.ts";
import { buildSystemdUnit, systemdUnitName } from "../src/core/service/systemd.ts";

const AGENT = "svc-test-agent";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-svc-"));
	process.env.STEWARD_HOME = home;
	process.env.STEWARD_SHARED_DIR = join(home, "shared");
});

afterEach(() => {
	delete process.env[ENV_SERVICE_MANAGER];
	delete process.env.STEWARD_HOME;
	delete process.env.STEWARD_SHARED_DIR;
	rmSync(home, { recursive: true, force: true });
});

describe("detectServiceManager", () => {
	it("honors the STEWARD_SERVICE_MANAGER override", () => {
		process.env[ENV_SERVICE_MANAGER] = "none";
		expect(detectServiceManager()).toBe("none");
		process.env[ENV_SERVICE_MANAGER] = "systemd";
		expect(detectServiceManager()).toBe("systemd");
		process.env[ENV_SERVICE_MANAGER] = "launchd";
		expect(detectServiceManager()).toBe("launchd");
	});

	it("falls back to the platform default for an unknown override", () => {
		process.env[ENV_SERVICE_MANAGER] = "garbage";
		const expected = process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "none";
		expect(detectServiceManager()).toBe(expected);
	});
});

describe("getServiceManager", () => {
	it("builds the requested backend", () => {
		expect(getServiceManager("none").kind).toBe("none");
		expect(getServiceManager("launchd").kind).toBe("launchd");
		expect(getServiceManager("systemd").kind).toBe("systemd");
	});
});

describe("daemonLaunchCommand", () => {
	it("is node + this CLI + `daemon <name>` (no port — the daemon binds ephemeral)", () => {
		const command = daemonLaunchCommand(AGENT);
		expect(command[0]).toBe(process.execPath);
		expect(command.slice(2)).toEqual(["daemon", AGENT]);
		expect(command).not.toContain("--port");
	});
});

describe("buildLaunchAgentPlist", () => {
	const plist = buildLaunchAgentPlist({
		label: launchAgentLabel(AGENT),
		programArguments: ["/usr/bin/node", "/opt/cli.js", "daemon", AGENT],
		workingDirectory: "/home/agent",
		stdoutPath: "/tmp/out.log",
		stderrPath: "/tmp/err.log",
		environment: { STEWARD_HOME: "/home/.steward", AMP: "a&b" },
	});

	it("renders an always-on LaunchAgent (RunAtLoad + KeepAlive)", () => {
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(plist).toContain(`<string>${launchAgentLabel(AGENT)}</string>`);
	});

	it("renders the program arguments and environment, XML-escaped", () => {
		expect(plist).toContain("<string>/opt/cli.js</string>");
		expect(plist).toContain("<key>STEWARD_HOME</key>");
		expect(plist).toContain("<string>/home/.steward</string>");
		expect(plist).toContain("<string>a&amp;b</string>");
	});
});

describe("buildSystemdUnit", () => {
	const unit = buildSystemdUnit({
		description: "steward agent test",
		execStart: ["/usr/bin/node", "/opt/my cli.js", "daemon", AGENT],
		workingDirectory: "/home/agent",
		environment: { STEWARD_HOME: "/home/.steward" },
	});

	it("renders an always-on user service", () => {
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).toContain("Environment=STEWARD_HOME=/home/.steward");
	});

	it("quotes ExecStart tokens that contain whitespace", () => {
		expect(unit).toContain('ExecStart=/usr/bin/node "/opt/my cli.js" daemon');
	});

	it("names the unit per agent", () => {
		expect(systemdUnitName(AGENT)).toBe(`steward-${AGENT}.service`);
	});
});

describe("none backend", () => {
	const none = getServiceManager("none");

	it("install/uninstall/start are inert (no OS supervisor)", () => {
		expect(() => none.install(AGENT)).not.toThrow();
		expect(() => none.uninstall(AGENT)).not.toThrow();
		expect(() => none.start(AGENT)).not.toThrow();
	});

	it("isRunning is false for an unknown agent", async () => {
		expect(await none.isRunning("no-such-agent-xyz")).toBe(false);
	});

	it("isRunning is false when no daemon is listening on the agent's port", async () => {
		AgentSettingsManager.createAgent({ name: AGENT });
		// No daemon was started, so the agent's fixed port has nothing answering /health.
		expect(await none.isRunning(AGENT)).toBe(false);
	});

	it("stop is a best-effort no-op when nothing is running", async () => {
		AgentSettingsManager.createAgent({ name: AGENT });
		expect(() => none.stop(AGENT)).not.toThrow();
		expect(() => none.stop("no-such-agent-xyz")).not.toThrow();
	});
});
