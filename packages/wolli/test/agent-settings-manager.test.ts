import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getAgentDir, getSoulPath } from "../src/config.ts";
import { AGENT_SCHEMA_VERSION, AgentSettingsManager, isValidAgentName } from "../src/core/agent-settings-manager.ts";
import { clearSharedDefaultsCache, SettingsManager } from "../src/core/settings-manager.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "wolli-test-"));
	process.env.WOLLI_HOME = home;
	// Isolate shared defaults so the merge can't read the real user's settings.json.
	process.env.WOLLI_SHARED_DIR = join(home, "shared");
});

afterEach(() => {
	delete process.env.WOLLI_HOME;
	delete process.env.WOLLI_SHARED_DIR;
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
		const created = AgentSettingsManager.createAgent({ name: "scribe" }).config;
		expect(created.name).toBe("scribe");
		expect(created.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
		expect(AgentSettingsManager.get("scribe")).toBeDefined();
		// The home tree ships with an empty SOUL.md the agent authors itself.
		expect(existsSync(getSoulPath("scribe"))).toBe(true);

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
		const legacy = { schemaVersion: 1, name: "old", createdAt: new Date().toISOString() };
		writeFileSync(getAgentConfigPath("old"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		expect(() => AgentSettingsManager.create("old")).toThrow(/Invalid agent config/);
	});

	it("folds an optional model into settings.defaultModel", () => {
		AgentSettingsManager.createAgent({ name: "scribe", model: "anthropic/claude-opus-4-8" });
		const store = AgentSettingsManager.create("scribe");
		expect(store.config.settings?.defaultModel).toBe("anthropic/claude-opus-4-8");
		// No flat `model` field on the persisted config.
		expect((store.config as Record<string, unknown>).model).toBeUndefined();
		// getDefaultModel returns the agent override as a combined reference.
		expect(store.getDefaultModel()).toBe("anthropic/claude-opus-4-8");
	});

	it("rejects duplicate creation", () => {
		AgentSettingsManager.createAgent({ name: "scribe" });
		expect(() => AgentSettingsManager.createAgent({ name: "scribe" })).toThrow(/already exists/);
	});

	it("rejects invalid names", () => {
		expect(() => AgentSettingsManager.createAgent({ name: "Bad Name" })).toThrow(/Invalid agent name/);
	});

	it("lists agents sorted by name", () => {
		AgentSettingsManager.createAgent({ name: "zeta" });
		AgentSettingsManager.createAgent({ name: "alpha" });
		expect(AgentSettingsManager.list().map((store) => store.name)).toEqual(["alpha", "zeta"]);
	});

	it("returns an empty list when no agents exist", () => {
		expect(AgentSettingsManager.list()).toEqual([]);
	});
});

describe("delete", () => {
	it("removes the agent's home dir", () => {
		AgentSettingsManager.createAgent({ name: "scratch" });
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
		const settings = SettingsManager.create();
		settings.setDefaultModelAndProvider("anthropic", "claude-opus-4-8");
		expect(settings.getDefaultProvider()).toBe("anthropic");
		expect(settings.getDefaultModel()).toBe("claude-opus-4-8");
	});

	it("an agent without an override inherits the shared default as a combined reference", () => {
		SettingsManager.create().setDefaultModelAndProvider("anthropic", "claude-opus-4-8");
		AgentSettingsManager.createAgent({ name: "scribe" });
		expect(AgentSettingsManager.create("scribe").getDefaultModel()).toBe("anthropic/claude-opus-4-8");
	});

	it("an agent's own override beats the shared default", () => {
		SettingsManager.create().setDefaultModelAndProvider("anthropic", "claude-opus-4-8");
		AgentSettingsManager.createAgent({ name: "scribe", model: "openai/gpt-5.4" });
		expect(AgentSettingsManager.create("scribe").getDefaultModel()).toBe("openai/gpt-5.4");
	});

	it("round-trips the default thinking level", () => {
		const settings = SettingsManager.create();
		settings.setDefaultThinkingLevel("high");
		expect(settings.getDefaultThinkingLevel()).toBe("high");
	});
});

describe("legacy configs", () => {
	it("tolerates stale purpose/deployedAt keys from the removed lifecycle (lax schema)", () => {
		AgentSettingsManager.createAgent({ name: "old" });
		const legacy = {
			schemaVersion: 1,
			name: "old",
			purpose: "old agent",
			deployedAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			port: 23456,
			token: "legacy-token",
		};
		writeFileSync(getAgentConfigPath("old"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		const store = AgentSettingsManager.create("old");
		expect(store.config.name).toBe("old");
		expect(store.config.port).toBe(23456);
	});
});
