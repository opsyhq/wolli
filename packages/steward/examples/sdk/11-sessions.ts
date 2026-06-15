/**
 * Session Management
 *
 * Steward keys sessions by AGENT, not by cwd. openAgentSession() resumes the
 * agent's latest session or starts a fresh one. The underlying JsonlSessionRepo
 * lists and opens individual sessions.
 */

import { AuthStorage, createAgentSession, ModelRegistry, openAgentSession } from "@opsyhq/steward";

const authStorage = AuthStorage.create();
const [model] = ModelRegistry.create(authStorage).getAvailable();
if (!model) {
	throw new Error("No models available. Add credentials with the steward CLI.");
}

// Resume the agent's most recent session (creates one if none exist yet).
const resumed = await openAgentSession("assistant");
console.log("Resumed session:", (await resumed.session.getMetadata()).id);

// Start a brand-new session instead of resuming.
const fresh = await openAgentSession("assistant", { fresh: true });
console.log("Fresh session:", (await fresh.session.getMetadata()).id);

// The repo lists every session for this agent.
const all = await resumed.repo.list({ cwd: resumed.cwd });
console.log(`\nFound ${all.length} sessions:`);
for (const meta of all.slice(0, 3)) {
	console.log(`  ${meta.id.slice(0, 8)}... - ${meta.path}`);
}

// Bind a harness to whichever session you opened.
const { env, session } = fresh;
const { harness } = await createAgentSession({
	env,
	session,
	model,
	systemPrompt: "You are a helpful assistant.",
	authStorage,
});
console.log("\nHarness bound to session:", (await session.getMetadata()).id, "model:", harness.getModel().id);
