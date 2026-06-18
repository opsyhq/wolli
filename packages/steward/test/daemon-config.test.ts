/**
 * Daemon config — round-trip and owner-only (600) atomic write.
 */

import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDaemonPath } from "../src/config.ts";
import {
	type DaemonConfig,
	deleteDaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../src/core/daemon-config.ts";

const AGENT = "config-test-agent";

function cfg(): DaemonConfig {
	return { pid: 1234, port: 5678, token: "secret-token", startedAt: new Date().toISOString(), version: "0.0.1" };
}

afterEach(() => {
	deleteDaemonConfig(AGENT);
});

describe("daemon config", () => {
	it("round-trips through save/load", () => {
		saveDaemonConfig(AGENT, cfg());
		expect(loadDaemonConfig(AGENT)).toMatchObject({ pid: 1234, port: 5678, token: "secret-token" });
	});

	it("returns undefined when no config is recorded", () => {
		expect(loadDaemonConfig("no-such-agent-xyz")).toBeUndefined();
	});

	it("writes the config owner-only (chmod 600 — it holds a bearer token)", () => {
		saveDaemonConfig(AGENT, cfg());
		expect(statSync(getAgentDaemonPath(AGENT)).mode & 0o777).toBe(0o600);
	});

	it("deleteDaemonConfig removes the config", () => {
		saveDaemonConfig(AGENT, cfg());
		deleteDaemonConfig(AGENT);
		expect(loadDaemonConfig(AGENT)).toBeUndefined();
	});
});
