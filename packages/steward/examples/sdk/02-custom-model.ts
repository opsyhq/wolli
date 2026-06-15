/**
 * Custom Model Selection
 *
 * Find a model via pi-ai or the registry, then build a session with a
 * specific model and thinking level.
 */

import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession } from "@opsyhq/steward";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Option 1: a specific built-in model by provider/id.
const opus = getModel("anthropic", "claude-opus-4-8");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// Option 2: via the registry (includes custom models from models.json).
const custom = modelRegistry.find("my-provider", "my-model");
if (custom) {
	console.log(`Found custom model: ${custom.provider}/${custom.id}`);
}

// Option 3: only models that have valid credentials.
const available = modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { env, session } = await openAgentSession("assistant");
	const { harness } = await createAgentSession({
		env,
		session,
		model: available[0],
		thinkingLevel: "medium", // off | minimal | low | medium | high | xhigh
		systemPrompt: "You are a helpful assistant.",
		authStorage,
	});

	harness.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await harness.prompt("Say hello in one sentence.");
	process.stdout.write("\n");
}
