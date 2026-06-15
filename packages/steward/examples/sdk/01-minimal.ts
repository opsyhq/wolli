/**
 * Minimal SDK Usage
 *
 * Build an AgentHarness for an existing agent and stream one reply.
 * Create the agent first: `steward new assistant`.
 */

import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession } from "@opsyhq/steward";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const [model] = modelRegistry.getAvailable();
if (!model) {
	throw new Error("No models available. Add credentials with the steward CLI.");
}

// Open (or resume) the agent's durable session and execution env.
const { env, session } = await openAgentSession("assistant");

const { harness } = await createAgentSession({
	env,
	session,
	model,
	systemPrompt: "You are a helpful assistant.",
	authStorage,
});

// Stream assistant text as it arrives.
harness.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await harness.prompt("Introduce yourself in one sentence.");
process.stdout.write("\n");
