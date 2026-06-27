import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getAgentDir, getSoulPath } from "../src/config.ts";
import {
	AGENT_SCHEMA_VERSION,
	AgentSettingsManager,
	clearSharedDefaultsCache,
	getDefaultModel,
	getDefaultProvider,
	getDefaultThinkingLevel,
	isDeployed,
	isValidAgentName,
	setSharedDefaultModel,
	setSharedDefaultThinkingLevel,
} from "../src/core/agent-settings-manager.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	// Isolate shared defaults so the merge can't read the real user's settings.json.
	process.env.STEWARD_SHARED_DIR = join(home, "shared");
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	delete process.env.STEWARD_SHARED_DIR;
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

describe("AgentSettingsManager round-trip", () => {
	it("creates and loads an agent at the current schema version", () => {
		const created = AgentSettingsManager.createAgent({ name: "scribe", purpose: "take meeting notes" }).config;
		expect(created.name).toBe("scribe");
		expect(created.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
		expect(created.purpose).toBe("take meeting notes");
		expect(AgentSettingsManager.get("scribe")).toBeDefined();

		const loaded = AgentSettingsManager.create("scribe").config;
		expect(loaded).toEqual(created);
	});

	it("allocates a fixed port + token at creation, distinct per agent", () => {
		const a = AgentSettingsManager.createAgent({ name: "alpha" }).config;
		const b = AgentSettingsManager.createAgent({ name: "beta" }).config;
		expect(typeof a.port).toBe("number");
		expect(a.port).toBeGreaterThan(0);
		expect(a.token).toMatch(/^[0-9a-f]{64}$/);
		expect(b.port).not.toBe(a.port);
		expect(b.token).not.toBe(a.token);
	});

	it("fails loud loading a config missing the required port/token", () => {
		AgentSettingsManager.createAgent({ name: "old" });
		const legacy = { schemaVersion: 1, name: "old", purpose: "", createdAt: new Date().toISOString() };
		writeFileSync(getAgentConfigPath("old"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		expect(() => AgentSettingsManager.create("old")).toThrow(/Invalid agent config/);
	});

	it("defaults purpose to an empty string when omitted (the agent distills it in-chat)", () => {
		const created = AgentSettingsManager.createAgent({ name: "scribe" }).config;
		expect(created.purpose).toBe("");
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("");
	});

	it("folds an optional model into settings.defaultModel", () => {
		AgentSettingsManager.createAgent({ name: "scribe", purpose: "x", model: "anthropic/claude-opus-4-8" });
		const store = AgentSettingsManager.create("scribe");
		expect(store.config.settings?.defaultModel).toBe("anthropic/claude-opus-4-8");
		// No flat `model` field on the persisted config.
		expect((store.config as Record<string, unknown>).model).toBeUndefined();
		// getDefaultModel returns the agent override as a combined reference.
		expect(store.getDefaultModel()).toBe("anthropic/claude-opus-4-8");
	});

	it("rejects duplicate creation", () => {
		AgentSettingsManager.createAgent({ name: "scribe", purpose: "take notes" });
		expect(() => AgentSettingsManager.createAgent({ name: "scribe", purpose: "again" })).toThrow(/already exists/);
	});

	it("rejects invalid names", () => {
		expect(() => AgentSettingsManager.createAgent({ name: "Bad Name", purpose: "x" })).toThrow(/Invalid agent name/);
	});

	it("lists agents sorted by name", () => {
		AgentSettingsManager.createAgent({ name: "zeta", purpose: "z" });
		AgentSettingsManager.createAgent({ name: "alpha", purpose: "a" });
		expect(AgentSettingsManager.list().map((store) => store.name)).toEqual(["alpha", "zeta"]);
	});

	it("returns an empty list when no agents exist", () => {
		expect(AgentSettingsManager.list()).toEqual([]);
	});
});

describe("deploy", () => {
	it("creates an agent undeployed with a SOUL.md", () => {
		const created = AgentSettingsManager.createAgent({ name: "calories", purpose: "track meals" }).config;
		expect(created.deployedAt).toBeNull();
		expect(isDeployed(created)).toBe(false);
		expect(existsSync(getSoulPath("calories"))).toBe(true);
	});

	it("deploy stamps an ISO timestamp", () => {
		AgentSettingsManager.createAgent({ name: "calories", purpose: "track meals" });
		const updated = AgentSettingsManager.create("calories").setAgentDeployed();
		expect(updated.deployedAt).toBeTruthy();
		expect(new Date(updated.deployedAt as string).toISOString()).toBe(updated.deployedAt);
		expect(isDeployed(updated)).toBe(true);
		expect(AgentSettingsManager.create("calories").getAgentDeployed()).toBe(true);
	});

	it("is idempotent — a second call leaves the timestamp unchanged", () => {
		AgentSettingsManager.createAgent({ name: "calories", purpose: "track meals" });
		const first = AgentSettingsManager.create("calories").setAgentDeployed();
		const second = AgentSettingsManager.create("calories").setAgentDeployed();
		expect(second.deployedAt).toBe(first.deployedAt);
	});
});

describe("setPurpose", () => {
	it("overwrites and persists the purpose", () => {
		AgentSettingsManager.createAgent({ name: "scribe" });
		const updated = AgentSettingsManager.create("scribe").setAgentPurpose("keep the meeting minutes");
		expect(updated.purpose).toBe("keep the meeting minutes");
		expect(AgentSettingsManager.create("scribe").config.purpose).toBe("keep the meeting minutes");
	});
});

describe("delete", () => {
	it("removes the agent's home dir", () => {
		AgentSettingsManager.createAgent({ name: "scratch", purpose: "temp" });
		expect(existsSync(getAgentDir("scratch"))).toBe(true);

		const result = AgentSettingsManager.delete("scratch");
		expect(result.ok).toBe(true);
		expect(existsSync(getAgentDir("scratch"))).toBe(false);
		expect(AgentSettingsManager.get("scratch")).toBeUndefined();
	});
});

describe("shared defaults writers", () => {
	// Defaults are process-cached; clear so each test reads its own isolated shared dir.
	beforeEach(() => clearSharedDefaultsCache());

	it("persists the default model as a separate provider + bare id", () => {
		setSharedDefaultModel("anthropic", "claude-opus-4-8");
		expect(getDefaultProvider()).toBe("anthropic");
		expect(getDefaultModel()).toBe("claude-opus-4-8");
	});

	it("an agent without an override inherits the shared default as a combined reference", () => {
		setSharedDefaultModel("anthropic", "claude-opus-4-8");
		AgentSettingsManager.createAgent({ name: "scribe" });
		expect(AgentSettingsManager.create("scribe").getDefaultModel()).toBe("anthropic/claude-opus-4-8");
	});

	it("an agent's own override beats the shared default", () => {
		setSharedDefaultModel("anthropic", "claude-opus-4-8");
		AgentSettingsManager.createAgent({ name: "scribe", model: "openai/gpt-5.4" });
		expect(AgentSettingsManager.create("scribe").getDefaultModel()).toBe("openai/gpt-5.4");
	});

	it("round-trips the default thinking level", () => {
		setSharedDefaultThinkingLevel("high");
		expect(getDefaultThinkingLevel()).toBe("high");
	});
});

describe("legacy configs", () => {
	it("loads a pre-deployedAt config (treated as not deployed)", () => {
		AgentSettingsManager.createAgent({ name: "old" });
		const legacy = {
			schemaVersion: 1,
			name: "old",
			purpose: "old agent",
			createdAt: new Date().toISOString(),
			port: 23456,
			token: "legacy-token",
		};
		writeFileSync(getAgentConfigPath("old"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		const store = AgentSettingsManager.create("old");
		expect(store.config.deployedAt).toBeUndefined();
		expect(store.getAgentDeployed()).toBe(false);
	});
});
