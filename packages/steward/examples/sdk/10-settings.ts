/**
 * Settings Configuration
 *
 * Read and override settings with SettingsManager, then feed a setting into a session.
 */

import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession, SettingsManager } from "@opsyhq/steward";

const cwd = process.cwd();

// Load current settings (merged global + project).
const settingsManager = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManager.getGlobalSettings(), null, 2));

// Override specific settings.
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

// Setters update memory immediately and queue persistence writes.
// Call flush() when you need a durability boundary.
settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

// Surface settings I/O errors at the app layer.
for (const { scope, error } of settingsManager.drainErrors()) {
	console.warn(`Warning (${scope} settings): ${error.message}`);
}

// For testing without file I/O:
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

// Apply a setting to a session — here, the configured default thinking level.
const authStorage = AuthStorage.create();
const [model] = ModelRegistry.create(authStorage).getAvailable();
if (model) {
	const { env, session } = await openAgentSession("assistant");
	const { harness } = await createAgentSession({
		env,
		session,
		model,
		systemPrompt: "You are a helpful assistant.",
		thinkingLevel: inMemorySettings.getDefaultThinkingLevel() ?? "off",
		authStorage,
	});
	console.log("Harness ready:", harness.getModel().id);
}
