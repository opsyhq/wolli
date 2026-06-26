/**
 * Public barrel for `@opsyhq/steward`.
 *
 * Re-exports the agent builder, system prompt, model resolver, the extension
 * subsystem, and key types — the surface an extension or SDK author builds against.
 */

export { serializeConversation } from "@opsyhq/agent";
// The client surface: the agent collection (`Steward`), one agent (`Agent`, which owns the transport),
// and the per-session proxy (`SessionHandle`) the interactive TUI + `--print` drive.
export { Agent, SessionHandle, Steward } from "./client.ts";
// Shared UI components + keybinding-hint helpers imported by the @opsyhq/cli daemon client (the
// interactive TUI lives in apps/cli); DynamicBorder and the keyHint/keyText helpers are also part
// of the extension SDK surface.
export { DynamicBorder } from "./components/dynamic-border.ts";
export {
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "./components/keybinding-hints.ts";
export * from "./config.ts";
// Per-agent plugin-manager factory: the daemon builds it to run installs server-side, and the
// @opsyhq/cli client's `plugins` command uses it for its read-only `list` arm.
export { type AgentPluginManager, createAgentPluginManager } from "./core/agent-plugin-manager.ts";
export {
	AgentRuntime,
	type AgentRuntimeOptions,
	type ContextInfo,
	type IntegrationInfo,
} from "./core/agent-runtime.ts";
export {
	AGENT_SCHEMA_VERSION,
	type AgentConfig,
	AgentConfigSchema,
	AgentSettingsManager,
	type CreateAgentOptions,
	getDefaultModel,
	getDefaultProvider,
	isDeployed,
	isValidAgentName,
	type Settings,
} from "./core/agent-settings-manager.ts";
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
export { executeBash } from "./core/bash-executor.ts";
export { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, isValidThinkingLevel } from "./core/defaults.ts";
export type { ResourceDiagnostic, ResourceSummary } from "./core/diagnostics.ts";
// The Environment seam: the single backend every file/shell tool consumes. Extensions reach the
// session's instance via ctx.environment; createHostEnvironment builds the unconfined host backend
// (the CLI `!` path uses it). The agent runtime builds the full target map via createEnvironments.
export { createHostEnvironment, type Environment, type FileStat } from "./core/environments/index.ts";
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
	ConversationPromptOptions,
	CustomToolCallEvent,
	EditorFactory,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionAPI,
	ExtensionContext,
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
	NewSessionOptions,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	Session,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
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
} from "./core/extensions/index.ts";
export type { ToolRenderContext } from "./core/extensions/types.ts";
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
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
	type KeyValueStore,
	type LoadIntegrationsResult,
	loadIntegrationFromFactory,
	loadIntegrations,
} from "./core/integrations/index.ts";
export {
	KEYBINDINGS,
	type Keybinding,
	type KeybindingsConfig,
	type KeybindingsManager,
	type KeyId,
	migrateKeybindingsConfig,
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
export { convertToLlm, createBashExecutionMessage, createCompactionSummaryMessage } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export {
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	parseModelPattern,
	type ResolveCliModelResult,
	resolveCliModel,
	resolveModelScope,
	type ScopedModel,
} from "./core/model-resolver.ts";
// Read types the @opsyhq/cli client's local `list` arm consumes against `dist`.
export type {
	ConfiguredPlugin,
	PluginManager,
	ResolvedPaths,
	ResolvedResource,
} from "./core/plugin-manager.ts";
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
export { detectServiceManager, type ServiceKind, type ServiceManager } from "./core/service/service-manager.ts";
export {
	type OpenAgentSessionOptions,
	type OpenAgentSessionResult,
	openAgentSession,
} from "./core/session.ts";
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
export {
	formatSkillsForPrompt,
	type LoadSkillsOptions,
	type LoadSkillsResult,
	loadSkills,
	type ParsedSkillBlock,
	parseSkillBlock,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
export { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export { type BuildSystemPromptOptions, buildSystemPrompt } from "./core/system-prompt.ts";
export { type BashToolDetails, type BashToolInput, createBashTool } from "./core/tools/bash.ts";
export { createDeployTool, type DeployToolDetails } from "./core/tools/deploy.ts";
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
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export { createLsTool, type LsToolDetails, type LsToolInput } from "./core/tools/ls.ts";
export { createMemoryTool, type MemoryToolDetails, type MemoryToolInput } from "./core/tools/memory.ts";
export { resolveReadPathAsync, resolveToCwd } from "./core/tools/path-utils.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput } from "./core/tools/read.ts";
export { createWriteTool, type WriteToolInput } from "./core/tools/write.ts";
export { type RunDaemonOptions, runDaemon } from "./server.ts";
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
} from "./theme/theme.ts";
export type {
	DaemonAgentState,
	DaemonCommand,
	DaemonControlEvent,
	DaemonResponse,
	DaemonSessionState,
	DaemonSessionSummary,
	ExtensionUIRequest,
	ExtensionUIResponse,
	OnboardServiceResult,
} from "./types.ts";
export { stripAnsi } from "./utils/ansi.ts";
export { applyExifOrientation } from "./utils/exif-orientation.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "./utils/fs-watch.ts";
export { formatPathRelativeToCwdOrAbsolute, resolvePath } from "./utils/paths.ts";
export { loadPhoton, type PhotonImageType } from "./utils/photon.ts";
export { ensureTool } from "./utils/tools-manager.ts";
