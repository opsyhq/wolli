/**
 * Public barrel for `@opsyhq/steward`.
 *
 * Mirrors `@opsyhq/coding-agent`'s index.ts: re-export the agent builder, system
 * prompt, model resolver, and key types. Grows per phase.
 */

export { type Args, parseArgs, printHelp } from "./cli/args.ts";
export * from "./config.ts";
export {
	AGENT_SCHEMA_VERSION,
	type AgentConfig,
	AgentConfigSchema,
	agentExists,
	type CreateAgentOptions,
	createAgent,
	isValidAgentName,
	listAgents,
	loadAgentConfig,
	saveAgentConfig,
} from "./core/agent-config.ts";
export {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthStatus,
	AuthStorage,
	type AuthStorageData,
	type OAuthCredential,
} from "./core/auth-storage.ts";
export { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
export {
	loadMemory,
	MEMORY_BUDGET,
	type Memory,
	readMemoryFile,
	USER_BUDGET,
	writeMemoryFile,
} from "./core/memory.ts";
export {
	defaultModelPerProvider,
	parseModelPattern,
	type ResolveCliModelResult,
	resolveCliModel,
} from "./core/model-resolver.ts";
export {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "./core/sdk.ts";
export {
	type OpenAgentSessionOptions,
	type OpenAgentSessionResult,
	openAgentSession,
} from "./core/session.ts";
export { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
export { type BuildSystemPromptOptions, buildSystemPrompt } from "./core/system-prompt.ts";
export { createMemoryTool, type MemoryToolDetails, type MemoryToolInput } from "./core/tools/memory.ts";
export { main } from "./main.ts";
export { InteractiveMode, type InteractiveModeOptions } from "./modes/interactive/interactive-mode.ts";
export { getEditorTheme, getMarkdownTheme, getSelectListTheme, style } from "./modes/interactive/theme.ts";
export { runPrintMode } from "./modes/print-mode.ts";
