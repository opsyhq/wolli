/**
 * Providers-subsystem unit check: the load + register lifecycle the `providers/` folder exists to
 * deliver, exercised against inline `defineProvider` files and a real `ModelRegistry` (no agent
 * home, no chat turn). Mirrors the integrations suite's "build the real seam" stance at the model
 * registry level.
 *
 *  1. a provider file that defines a model registers it into the registry, and it shows up in
 *     `getAvailable()` once its literal `apiKey` counts as configured auth;
 *  2. a `baseUrl`-only file named after an existing provider redirects that provider's models
 *     instead of defining new ones;
 *  3. a broken file (non-object default export) becomes an error entry — the diagnostic the
 *     resource summary surfaces — rather than a throw that aborts the rest.
 *
 * The bare "wolli" value import is the point: a real `providers/<name>.ts` module must resolve
 * through jiti, and the provider name comes from the file basename.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { loadProviders } from "../src/core/providers/loader.ts";
import { defineProvider, type ProviderConfig } from "../src/core/providers/types.ts";
import { defineProvider as barrelDefineProvider } from "../src/index.ts";

// A proxy that fronts a model behind a literal API key — the docs/providers.md "Defining a provider"
// example. The literal key makes the model pass the configured-auth filter in getAvailable().
const PROXY_PROVIDER_SOURCE = `
import { defineProvider } from "wolli";

export default defineProvider({
	baseUrl: "https://proxy.example.com",
	apiKey: "test-key",
	api: "anthropic-messages",
	models: [
		{
			id: "claude-sonnet-4-20250514",
			name: "Claude 4 Sonnet (proxy)",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
		},
	],
});
`;

// Defines a "gateway" provider with one model, so a later baseUrl-only file has something to redirect.
const GATEWAY_PROVIDER_SOURCE = `
import { defineProvider } from "wolli";

export default defineProvider({
	baseUrl: "https://origin.example.com",
	apiKey: "test-key",
	api: "anthropic-messages",
	models: [
		{
			id: "gw-model",
			name: "Gateway Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
	],
});
`;

// A baseUrl-only file: redirects an existing provider rather than defining new models.
const GATEWAY_OVERRIDE_SOURCE = `
import { defineProvider } from "wolli";

export default defineProvider({ baseUrl: "https://mirror.example.com" });
`;

describe("defineProvider", () => {
	it("is identity at runtime", () => {
		const config: ProviderConfig = { baseUrl: "https://proxy.example.com" };
		expect(defineProvider(config)).toBe(config);
	});

	it("is the defineProvider the package barrel exports", () => {
		expect(barrelDefineProvider).toBe(defineProvider);
	});
});

describe("loadProviders", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wolli-providers-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads a defineProvider file importing the bare wolli specifier, naming it after the file", async () => {
		const providerPath = join(dir, "my-proxy.ts");
		writeFileSync(providerPath, PROXY_PROVIDER_SOURCE, "utf-8");

		const result = await loadProviders([providerPath], dir);

		expect(result.errors).toEqual([]);
		expect(result.providers).toHaveLength(1);
		expect(result.providers[0].name).toBe("my-proxy");
		expect(result.providers[0].path).toBe(providerPath);
	});

	it("registers a provider file's model so it appears in modelRegistry.getAvailable()", async () => {
		const providerPath = join(dir, "my-proxy.ts");
		writeFileSync(providerPath, PROXY_PROVIDER_SOURCE, "utf-8");

		const result = await loadProviders([providerPath], dir);
		expect(result.errors).toEqual([]);

		const registry = ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), join(dir, "models.json"));
		registry.registerProvider(result.providers[0].name, result.providers[0].config);

		expect(
			registry.getAvailable().some((m) => m.provider === "my-proxy" && m.id === "claude-sonnet-4-20250514"),
		).toBe(true);
	});

	it("a baseUrl-only file redirects an existing provider's models", async () => {
		const registry = ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), join(dir, "models.json"));

		// A provider file that defines a model, so there is an existing provider to redirect.
		const defineDir = join(dir, "define");
		mkdirSync(defineDir, { recursive: true });
		writeFileSync(join(defineDir, "gateway.ts"), GATEWAY_PROVIDER_SOURCE, "utf-8");
		const defined = await loadProviders([join(defineDir, "gateway.ts")], defineDir);
		expect(defined.errors).toEqual([]);
		registry.registerProvider(defined.providers[0].name, defined.providers[0].config);
		expect(registry.find("gateway", "gw-model")?.baseUrl).toBe("https://origin.example.com");

		// A baseUrl-only file named after the same provider redirects it, models intact.
		const overrideDir = join(dir, "override");
		mkdirSync(overrideDir, { recursive: true });
		writeFileSync(join(overrideDir, "gateway.ts"), GATEWAY_OVERRIDE_SOURCE, "utf-8");
		const override = await loadProviders([join(overrideDir, "gateway.ts")], overrideDir);
		expect(override.errors).toEqual([]);
		expect(override.providers[0].name).toBe("gateway");
		registry.registerProvider(override.providers[0].name, override.providers[0].config);

		expect(registry.find("gateway", "gw-model")?.baseUrl).toBe("https://mirror.example.com");
	});

	it("records a non-object default export as an error entry, not a throw", async () => {
		const badPath = join(dir, "broken.ts");
		writeFileSync(badPath, "export default 42;\n", "utf-8");

		const result = await loadProviders([badPath], dir);

		expect(result.providers).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(badPath);
		expect(result.errors[0].error).toContain("defineProvider");
	});
});
