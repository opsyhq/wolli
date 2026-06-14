import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getSoulPath } from "../src/config.ts";
import {
	agentExists,
	commissionAgent,
	createAgent,
	isCommissioned,
	isValidAgentName,
	listAgents,
	loadAgentConfig,
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

describe("commissioning", () => {
	it("creates an agent uncommissioned with a SOUL.md", () => {
		const created = createAgent({ name: "calories", purpose: "track meals" });
		expect(created.commissionedAt).toBeNull();
		expect(isCommissioned(created)).toBe(false);
		expect(existsSync(getSoulPath("calories"))).toBe(true);
	});

	it("commissionAgent stamps an ISO timestamp", () => {
		createAgent({ name: "calories", purpose: "track meals" });
		const updated = commissionAgent("calories");
		expect(updated.commissionedAt).toBeTruthy();
		expect(new Date(updated.commissionedAt as string).toISOString()).toBe(updated.commissionedAt);
		expect(isCommissioned(updated)).toBe(true);
		expect(isCommissioned(loadAgentConfig("calories"))).toBe(true);
	});

	it("is idempotent — a second call leaves the timestamp unchanged", () => {
		createAgent({ name: "calories", purpose: "track meals" });
		const first = commissionAgent("calories");
		const second = commissionAgent("calories");
		expect(second.commissionedAt).toBe(first.commissionedAt);
	});

	it("loads agent.json written before commissionedAt existed (back-compat)", () => {
		createAgent({ name: "legacy", purpose: "old agent" });
		// Simulate a pre-feature config: no commissionedAt key at all.
		const legacy = { schemaVersion: 1, name: "legacy", purpose: "old agent", createdAt: new Date().toISOString() };
		writeFileSync(getAgentConfigPath("legacy"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		const loaded = loadAgentConfig("legacy");
		expect(loaded.commissionedAt).toBeUndefined();
		expect(isCommissioned(loaded)).toBe(false);
	});
});
