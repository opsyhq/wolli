import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getAgentDir, getSoulPath } from "../src/config.ts";
import {
	agentExists,
	createAgent,
	deleteAgent,
	deployAgent,
	isDeployed,
	isValidAgentName,
	listAgents,
	loadAgentConfig,
	setAgentPurpose,
} from "../src/core/agent-config.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("isValidAgentName", () => {
	it("accepts kebab/alphanumeric names", () => {
		expect(isValidAgentName("scribe")).toBe(true);
		expect(isValidAgentName("calorie-bot")).toBe(true);
		expect(isValidAgentName("a1")).toBe(true);
	});

	it("rejects spaces, leading hyphens, uppercase, and empties", () => {
		expect(isValidAgentName("Bad Name")).toBe(false);
		expect(isValidAgentName("-leading")).toBe(false);
		expect(isValidAgentName("Scribe")).toBe(false);
		expect(isValidAgentName("")).toBe(false);
	});
});

describe("agent-config round-trip", () => {
	it("creates and loads an agent", () => {
		const created = createAgent({ name: "scribe", purpose: "take meeting notes" });
		expect(created.name).toBe("scribe");
		expect(created.schemaVersion).toBe(1);
		expect(created.purpose).toBe("take meeting notes");
		expect(agentExists("scribe")).toBe(true);

		const loaded = loadAgentConfig("scribe");
		expect(loaded).toEqual(created);
	});

	it("defaults purpose to an empty string when omitted (the agent distills it in-chat)", () => {
		const created = createAgent({ name: "scribe" });
		expect(created.purpose).toBe("");
		expect(loadAgentConfig("scribe").purpose).toBe("");
	});

	it("persists an optional model", () => {
		createAgent({ name: "scribe", purpose: "x", model: "anthropic/claude-opus-4-8" });
		expect(loadAgentConfig("scribe").model).toBe("anthropic/claude-opus-4-8");
	});

	it("rejects duplicate creation", () => {
		createAgent({ name: "scribe", purpose: "take notes" });
		expect(() => createAgent({ name: "scribe", purpose: "again" })).toThrow(/already exists/);
	});

	it("rejects invalid names", () => {
		expect(() => createAgent({ name: "Bad Name", purpose: "x" })).toThrow(/Invalid agent name/);
	});

	it("lists agents sorted by name", () => {
		createAgent({ name: "zeta", purpose: "z" });
		createAgent({ name: "alpha", purpose: "a" });
		expect(listAgents().map((agent) => agent.name)).toEqual(["alpha", "zeta"]);
	});

	it("returns an empty list when no agents exist", () => {
		expect(listAgents()).toEqual([]);
	});
});

describe("deploy", () => {
	it("creates an agent undeployed with a SOUL.md", () => {
		const created = createAgent({ name: "calories", purpose: "track meals" });
		expect(created.deployedAt).toBeNull();
		expect(isDeployed(created)).toBe(false);
		expect(existsSync(getSoulPath("calories"))).toBe(true);
	});

	it("deployAgent stamps an ISO timestamp", () => {
		createAgent({ name: "calories", purpose: "track meals" });
		const updated = deployAgent("calories");
		expect(updated.deployedAt).toBeTruthy();
		expect(new Date(updated.deployedAt as string).toISOString()).toBe(updated.deployedAt);
		expect(isDeployed(updated)).toBe(true);
		expect(isDeployed(loadAgentConfig("calories"))).toBe(true);
	});

	it("is idempotent — a second call leaves the timestamp unchanged", () => {
		createAgent({ name: "calories", purpose: "track meals" });
		const first = deployAgent("calories");
		const second = deployAgent("calories");
		expect(second.deployedAt).toBe(first.deployedAt);
	});

	it("loads agent.json written before deployedAt existed (treated as not deployed)", () => {
		createAgent({ name: "legacy", purpose: "old agent" });
		// Simulate a pre-feature config: no deployedAt key at all.
		const legacy = { schemaVersion: 1, name: "legacy", purpose: "old agent", createdAt: new Date().toISOString() };
		writeFileSync(getAgentConfigPath("legacy"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		const loaded = loadAgentConfig("legacy");
		expect(loaded.deployedAt).toBeUndefined();
		expect(isDeployed(loaded)).toBe(false);
	});
});

describe("setAgentPurpose", () => {
	it("overwrites and persists the purpose", () => {
		createAgent({ name: "scribe" });
		const updated = setAgentPurpose("scribe", "keep the meeting minutes");
		expect(updated.purpose).toBe("keep the meeting minutes");
		expect(loadAgentConfig("scribe").purpose).toBe("keep the meeting minutes");
	});
});

describe("deleteAgent", () => {
	it("removes the agent's home dir", () => {
		createAgent({ name: "scratch", purpose: "temp" });
		expect(existsSync(getAgentDir("scratch"))).toBe(true);

		const result = deleteAgent("scratch");
		expect(result.ok).toBe(true);
		expect(existsSync(getAgentDir("scratch"))).toBe(false);
		expect(agentExists("scratch")).toBe(false);
	});
});
