/**
 * Tools Configuration
 *
 * Pass steward's built-in tool factories to choose which tools the agent has.
 * Each factory is bound to the directory the tool operates in — here the agent's
 * own workspace, returned by openAgentSession() as `cwd`.
 *
 * For custom tools, see ../extensions/ — extensions register tools via
 * steward.registerTool().
 */

import {
	AuthStorage,
	createAgentSession,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	ModelRegistry,
	openAgentSession,
} from "@opsyhq/steward";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const [model] = modelRegistry.getAvailable();
if (!model) {
	throw new Error("No models available. Add credentials with the steward CLI.");
}

const { env, session, cwd } = await openAgentSession("assistant");

// Read-only: exploration tools, no edit/write/bash.
const { harness: readOnly } = await createAgentSession({
	env,
	session,
	model,
	systemPrompt: "You are a read-only assistant.",
	tools: [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)],
	authStorage,
});
console.log("Read-only harness ready:", readOnly.getModel().id);

// Full read/write tool set.
const { harness: full } = await createAgentSession({
	env,
	session,
	model,
	systemPrompt: "You are a coding assistant.",
	tools: [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd)],
	authStorage,
});
console.log("Full harness ready:", full.getModel().id);
