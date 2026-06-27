/**
 * Per-agent auth tier: an `AuthStorage` built with a `fallback` store overrides the
 * fallback per provider (agent-first by presence) and inherits it for the rest. These
 * exercise the layering directly on `AuthStorage`, plus the `ModelRegistry` gate that
 * consumes it, using distinct sentinel keys so the resolved tier is unambiguous.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, type AuthStorageData } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

// Provider env vars that would otherwise shadow the "no credential" cases below.
const NEUTRALIZED_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY"];

describe("AuthStorage credential tiers", () => {
	let tempDir: string;
	let agentPath: string;
	let globalPath: string;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "steward-auth-tiers-"));
		agentPath = join(tempDir, "agent-auth.json");
		globalPath = join(tempDir, "global-auth.json");
		for (const name of NEUTRALIZED_ENV_VARS) {
			savedEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
		clearConfigValueCache();
	});

	const apiKey = (key: string): AuthStorageData[string] => ({ type: "api_key", key });

	/** Build an agent-tier store layered over a global-tier store, both backed by temp files. */
	function buildLayered(agentData: AuthStorageData, globalData: AuthStorageData): AuthStorage {
		writeFileSync(agentPath, JSON.stringify(agentData));
		writeFileSync(globalPath, JSON.stringify(globalData));
		return AuthStorage.create(agentPath, AuthStorage.create(globalPath));
	}

	// T1 — agent overrides global per provider; missing providers gap-fill from global.
	it("resolves agent credential over global, per provider", async () => {
		const store = buildLayered(
			{ anthropic: apiKey("AGENT") },
			{ anthropic: apiKey("GLOBAL"), openai: apiKey("GOPENAI") },
		);

		expect(await store.getApiKey("anthropic")).toBe("AGENT");
		expect(await store.getApiKey("openai")).toBe("GOPENAI");
	});

	// T2 — presence decides the tier; a present-but-broken agent credential never falls through.
	describe("presence-based, no cross-tier validity fallback", () => {
		it("keeps a broken agent api key instead of the good global one", async () => {
			const store = buildLayered({ anthropic: apiKey("BROKEN") }, { anthropic: apiKey("GOOD") });

			const resolved = await store.getApiKey("anthropic");
			expect(resolved).toBe("BROKEN");
			expect(resolved).not.toBe("GOOD");
		});

		it("never returns the global value for an unknown-provider agent OAuth credential", async () => {
			// `sentinel-oauth` is not a registered OAuth provider, so the expired token can't refresh and
			// resolves to undefined — it must not fall through to the global tier's api key.
			const store = buildLayered(
				{ "sentinel-oauth": { type: "oauth", access: "x", refresh: "y", expires: Date.now() - 10_000 } },
				{ "sentinel-oauth": apiKey("GOOD") },
			);

			const resolved = await store.getApiKey("sentinel-oauth");
			expect(resolved).toBeUndefined();
			expect(resolved).not.toBe("GOOD");
		});

		it("never returns the global value when the agent OAuth refresh fails", async () => {
			// A registered provider whose expired token fails to refresh exercises the refresh path itself:
			// the present-but-broken agent credential resolves to undefined, not the global tier's api key.
			const providerId = `tier-refresh-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Tier Refresh Fail",
				async login() {
					throw new Error("not used");
				},
				async refreshToken() {
					throw new Error("refresh failed");
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});
			const store = buildLayered(
				{ [providerId]: { type: "oauth", access: "expired", refresh: "r", expires: Date.now() - 10_000 } },
				{ [providerId]: apiKey("GOOD") },
			);

			const resolved = await store.getApiKey(providerId);
			expect(resolved).toBeUndefined();
			expect(resolved).not.toBe("GOOD");
		});
	});

	// T3 — a provider absent from the agent tier gap-fills from global.
	it("gap-fills a missing provider from the global tier", async () => {
		const store = buildLayered({}, { anthropic: apiKey("GLOBAL") });

		expect(store.hasAuth("anthropic")).toBe(true);
		expect(await store.getApiKey("anthropic")).toBe("GLOBAL");
	});

	// T4 — writes and list stay within the agent tier; the global file is untouched.
	it("keeps writes and list() in the agent tier", () => {
		const store = buildLayered(
			{ anthropic: apiKey("AGENT") },
			{ anthropic: apiKey("GLOBAL"), openai: apiKey("GOPENAI") },
		);

		// list() reflects only the agent tier even though global holds more.
		expect(store.list()).toEqual(["anthropic"]);

		store.set("openai", apiKey("NEWAGENT"));
		store.logout("anthropic");

		const agentFile = JSON.parse(readFileSync(agentPath, "utf-8")) as AuthStorageData;
		const globalFile = JSON.parse(readFileSync(globalPath, "utf-8")) as AuthStorageData;

		// The agent file gained openai and lost anthropic; the global file is unchanged.
		expect(agentFile).toEqual({ openai: apiKey("NEWAGENT") });
		expect(globalFile).toEqual({ anthropic: apiKey("GLOBAL"), openai: apiKey("GOPENAI") });
	});

	// T5 — a store with no fallback behaves exactly as a single-tier store does today.
	describe("single-tier regression (no fallback)", () => {
		it("resolves stored credentials with no fallback", async () => {
			writeFileSync(globalPath, JSON.stringify({ anthropic: apiKey("SOLO") }));
			const store = AuthStorage.create(globalPath);

			expect(await store.getApiKey("anthropic")).toBe("SOLO");
			expect(store.hasAuth("anthropic")).toBe(true);
			expect(store.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		it("honors a runtime override on a single-tier store", async () => {
			writeFileSync(globalPath, JSON.stringify({}));
			const store = AuthStorage.create(globalPath);
			store.setRuntimeApiKey("anthropic", "RUNTIME");

			expect(await store.getApiKey("anthropic")).toBe("RUNTIME");
			expect(store.hasAuth("anthropic")).toBe(true);
			expect(store.getAuthStatus("anthropic")).toEqual({ configured: false, source: "runtime", label: "--api-key" });
		});
	});

	// getAuthStatus mirrors getApiKey/hasAuth precedence: an agent-tier runtime override wins over a
	// stored global credential, instead of the status deferring to the global tier.
	it("reports the agent runtime override over the global tier in getAuthStatus", async () => {
		const store = buildLayered({}, { anthropic: apiKey("GLOBAL") });
		store.setRuntimeApiKey("anthropic", "RUNTIME");

		expect(store.getAuthStatus("anthropic")).toEqual({ configured: false, source: "runtime", label: "--api-key" });
		expect(await store.getApiKey("anthropic")).toBe("RUNTIME");
	});

	// T6 — the ModelRegistry gate and key resolution agree on the same tier across the matrix.
	describe("gating matches resolution via ModelRegistry", () => {
		const modelId = "claude-opus-4-8";

		async function check(agentData: AuthStorageData, globalData: AuthStorageData) {
			const registry = ModelRegistry.inMemory(buildLayered(agentData, globalData));
			const model = registry.find("anthropic", modelId);
			if (!model) throw new Error(`built-in model anthropic/${modelId} not found`);
			const available = registry.getAvailable().some((m) => m.provider === "anthropic" && m.id === modelId);
			const auth = await registry.getApiKeyAndHeaders(model);
			return { configured: registry.hasConfiguredAuth(model), available, auth };
		}

		it("agent-only: both gate and resolution see the agent tier", async () => {
			const { configured, available, auth } = await check({ anthropic: apiKey("AGENT") }, {});
			expect(configured).toBe(true);
			expect(available).toBe(true);
			expect(auth).toMatchObject({ ok: true, apiKey: "AGENT" });
		});

		it("global-only: both gate and resolution see the global tier", async () => {
			const { configured, available, auth } = await check({}, { anthropic: apiKey("GLOBAL") });
			expect(configured).toBe(true);
			expect(available).toBe(true);
			expect(auth).toMatchObject({ ok: true, apiKey: "GLOBAL" });
		});

		it("neither: gate excludes and resolution yields no key", async () => {
			const { configured, available, auth } = await check({}, {});
			expect(configured).toBe(false);
			expect(available).toBe(false);
			expect(auth).toEqual({ ok: true, apiKey: undefined, headers: undefined });
		});

		it("agent-broken + global-good: both resolve the agent tier", async () => {
			const { configured, available, auth } = await check(
				{ anthropic: apiKey("BROKEN") },
				{ anthropic: apiKey("GOOD") },
			);
			expect(configured).toBe(true);
			expect(available).toBe(true);
			expect(auth).toMatchObject({ ok: true, apiKey: "BROKEN" });
		});
	});
});
