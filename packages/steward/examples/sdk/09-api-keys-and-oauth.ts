/**
 * API Keys and OAuth
 *
 * Configure credential resolution via AuthStorage, then resolve models with it.
 * AuthStorage checks runtime overrides → auth.json (api keys + OAuth, tokens
 * auto-refreshed) → environment variables.
 */

import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession } from "@opsyhq/steward";

// Default: ~/.steward/agent/auth.json + models.json.
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Custom locations for auth.json and models.json.
const customAuth = AuthStorage.create("/tmp/my-app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/tmp/my-app/models.json");
console.log("Custom registry models:", customRegistry.getAvailable().length);

// Runtime API key override (not persisted to disk).
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Built-in models only (ignore models.json on disk).
const builtInOnly = ModelRegistry.inMemory(authStorage);
console.log("Built-in models:", builtInOnly.getAvailable().length);

const [model] = modelRegistry.getAvailable();
if (model) {
	const { env, session } = await openAgentSession("assistant");
	const { harness } = await createAgentSession({
		env,
		session,
		model,
		systemPrompt: "You are a helpful assistant.",
		authStorage, // credential resolution flows through this store
	});
	console.log("Harness ready with model:", harness.getModel().id);
}
