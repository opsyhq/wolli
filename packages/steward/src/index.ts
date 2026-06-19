/**
 * Public barrel for `@opsyhq/steward`.
 *
 * Re-exports the agent builder, system prompt, model resolver, the extension
 * subsystem, and key types — the surface an extension or SDK author builds against.
 */

export { serializeConversation } from "@opsyhq/agent";
export { type Args, parseArgs, printHelp } from "./cli/args.ts";
export * from "./config.ts";
export {
	AGENT_SCHEMA_VERSION,
	type AgentConfig,
	AgentConfigSchema,
	agentExists,
	type CreateAgentOptions,
	createAgent,
	deleteAgent,
	deployAgent,
	isDeployed,
	isValidAgentName,
	listAgents,
	loadAgentConfig,
	saveAgentConfig,
	setAgentPurpose,
} from "./core/agent-config.ts";
export {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthStatus,
	AuthStorage,
	type AuthStorageData,
	type OAuthCredential,
} from "./core/auth-storage.ts";
// Engine surface consumed by the @opsyhq/cli daemon client (Phase 2, Slice 1): the interactive
// TUI + the built-in tool renderers were lifted into apps/cli and reach back for these helpers.
export { executeBashWithOperations } from "./core/bash-executor.ts";
export { type DaemonConfig, deleteDaemonConfig, loadDaemonConfig } from "./core/daemon-config.ts";
export { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
export type { ResourceDiagnostic, ResourceSummary } from "./core/diagnostics.ts";
// Extension system
export type {
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditorFactory,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	LsToolCallEvent,
	MessageRenderer,
	MessageRenderOptions,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandSource,
	SourceInfo,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionMode,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/index.ts";
export {
	createExtensionRuntime,
	defineTool,
	discoverAndLoadExtensions,
	ExtensionRunner,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.ts";
export type { ToolRenderContext } from "./core/extensions/types.ts";
export { FooterDataProvider, type ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export { configureHttpDispatcher } from "./core/http-dispatcher.ts";
export {
	type IntegrationAccountRecord,
	IntegrationAccountStorage,
	type IntegrationAccountStorageData,
} from "./core/integration-account-storage.ts";
// Integration system
export {
	createIntegrationRuntime,
	type Integration,
	type IntegrationAction,
	type IntegrationActionContext,
	type IntegrationConfig,
	type IntegrationError,
	type IntegrationErrorListener,
	type IntegrationFactory,
	type IntegrationHandle,
	type IntegrationOnboardContext,
	type IntegrationOnboardUI,
	type IntegrationRunContext,
	IntegrationRunner,
	type IntegrationRuntime,
	type IntegrationRuntimeState,
	type IntegrationsAPI,
	type LoadIntegrationsResult,
	loadIntegrationFromFactory,
	loadIntegrations,
} from "./core/integrations/index.ts";
export {
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
} from "./core/keybindings.ts";
export {
	loadMemory,
	MEMORY_BUDGET,
	type Memory,
	readMemoryFile,
	SOUL_BUDGET,
	USER_BUDGET,
	writeMemoryFile,
} from "./core/memory.ts";
export { convertToLlm, createBashExecutionMessage } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export {
	defaultModelPerProvider,
	parseModelPattern,
	type ResolveCliModelResult,
	resolveCliModel,
} from "./core/model-resolver.ts";
// Config-value resolution (so integration `onboard(ctx)` can type `ctx.resolve`).
export {
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
} from "./core/resolve-config-value.ts";
export {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "./core/sdk.ts";
// OS service backend (deploy/delete + the daemon entry use it to keep a deployed agent always-on).
export {
	detectServiceManager,
	getServiceManager,
	type ServiceKind,
	type ServiceManager,
} from "./core/service/service-manager.ts";
export {
	type OpenAgentSessionOptions,
	type OpenAgentSessionResult,
	openAgentSession,
} from "./core/session.ts";
export { SessionHost, type SessionHostOptions } from "./core/session-host.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
	SessionTreeNode,
} from "./core/session-manager.ts";
export { SessionManager } from "./core/session-manager.ts";
export { getDefaultModel, getDefaultProvider } from "./core/settings.ts";
export {
	type Settings,
	SettingsManager,
	type SettingsManagerCreateOptions,
} from "./core/settings-manager.ts";
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type ParsedSkillBlock,
	parseSkillBlock,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
export { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export { type BuildSystemPromptOptions, buildSystemPrompt } from "./core/system-prompt.ts";
export { type BashToolDetails, type BashToolInput, createBashTool } from "./core/tools/bash.ts";
export { createDeployTool, type DeployToolDetails, type DeployToolInput } from "./core/tools/deploy.ts";
export { createEditTool, type EditToolDetails, type EditToolInput } from "./core/tools/edit.ts";
// edit-diff render helpers consumed by the apps/cli built-in edit renderer (Phase 2, Slice 1).
export {
	computeEditsDiff,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
} from "./core/tools/edit-diff.ts";
export { createFindTool, type FindToolDetails, type FindToolInput } from "./core/tools/find.ts";
export { createGrepTool, type GrepToolDetails, type GrepToolInput } from "./core/tools/grep.ts";
export type { ToolName } from "./core/tools/index.ts";
// Tool primitives for custom tools and extensions
export {
	type BashOperations,
	createLocalBashOperations,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	formatSize,
	type ReadOperations,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export { createLsTool, type LsToolDetails, type LsToolInput } from "./core/tools/ls.ts";
export { createMemoryTool, type MemoryToolDetails, type MemoryToolInput } from "./core/tools/memory.ts";
export { resolveReadPathAsync, resolveToCwd } from "./core/tools/path-utils.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput } from "./core/tools/read.ts";
export { createWriteTool, type WriteToolInput } from "./core/tools/write.ts";
export { main, type RunDaemonOptions, runDaemon } from "./main.ts";
export type {
	DaemonCommand,
	DaemonResponse,
	DaemonSessionState,
	ExtensionUIRequest,
	ExtensionUIResponse,
} from "./modes/daemon/daemon-types.ts";
// UI components for extensions + the @opsyhq/cli daemon client (the interactive TUI lives in
// apps/cli; these are the shared pieces it imports — kept here because the engine's startup/
// onboarding flow and extension runner still depend on them).
export { CountdownTimer } from "./modes/interactive/components/countdown-timer.ts";
export { DynamicBorder } from "./modes/interactive/components/dynamic-border.ts";
export { ExtensionInputComponent } from "./modes/interactive/components/extension-input.ts";
export { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
export {
	formatKeyText,
	type KeyTextFormatOptions,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "./modes/interactive/components/keybinding-hints.ts";
export {
	getAvailableThemesWithPaths,
	getEditorTheme,
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getThemeByName,
	highlightCode,
	initTheme,
	setTheme,
	setThemeInstance,
	Theme,
	theme,
} from "./modes/interactive/theme/theme.ts";
export { stripAnsi } from "./utils/ansi.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { convertToPng } from "./utils/image-convert.ts";
export { formatPathRelativeToCwdOrAbsolute, resolvePath } from "./utils/paths.ts";
export { ensureTool } from "./utils/tools-manager.ts";
