/**
 * Agent runtime + conversation — an agent's durable/shared state and its live per-conversation engine.
 *
 * `AgentRuntime` owns the durable half: auth, the model registry, integration accounts, the single
 * extension + integration runners, the sandbox, and the resource-derived defs (skills, prompts, tools).
 * It creates, swaps, and reloads conversations. `Conversation` owns the per-conversation half: the live
 * `AgentHarness`, `SessionManager`, env, frozen system prompt, turn state, the dispatch pipeline, and
 * the harness↔extension event wiring. At N=1 a runtime holds one conversation; targeting is always an
 * explicit handle (`runtime.getConversation()`), never an ambient current — so no AsyncLocalStorage.
 *
 * The system prompt is frozen for a conversation's lifetime, so changing it (the birth instruction
 * dropping at deploy) needs a fresh conversation.
 *
 * The harness event mechanism is split three ways:
 *  (a) `harness.on(type)` native mutating hooks — tool_call, tool_result, context,
 *      before_agent_start, before_provider_payload, session_before_compact;
 *  (b) `harness.subscribe()` — translates AgentEvent/own-events to lifecycle ExtensionEvents;
 *  (c) `harness.onMessageEnd()` — the message_end interceptor (subscribe/on return values are
 *      discarded for message_end; persistence rides the interceptor, so a mutating message_end uses it).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	type ImageContent,
	type Model,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
	type OAuthSelectPrompt,
	type TextContent,
} from "@earendil-works/pi-ai";
import {
	AgentHarness,
	type AgentHarnessResources,
	type AgentMessage,
	type AgentTool,
	buildSessionContext,
	calculateContextTokens,
	estimateContextTokens,
	type SessionContext,
	type SessionTreeEntry,
	type ThinkingLevel,
} from "@opsyhq/agent";
import type { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getAgentApprovalsPath, getAgentDir, getAgentIntegrationsPath, getSessionsDir } from "../config.ts";
import type { AuthSelectorProvider } from "../types.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { createAgentPluginManager } from "./agent-plugin-manager.ts";
import { type AgentConfig, AgentSettingsManager, isDeployed } from "./agent-settings-manager.ts";
import { createApprovalGate } from "./approval/approval-gate.ts";
import { ApprovalStore } from "./approval/approval-storage.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ResourceDiagnostic, ResourceSummary } from "./diagnostics.ts";
import { type AgentEnvironments, createEnvironments, resetSandbox, stopContainer } from "./environments/index.ts";
import {
	type ExtensionErrorListener,
	ExtensionRunner,
	emitSessionShutdownEvent,
	type NewSessionHandler,
} from "./extensions/runner.ts";
import type {
	ContextUsage,
	Conversation as ConversationApi,
	ConversationPromptOptions,
	ExtensionMode,
	ExtensionUIContext,
	NewSessionOptions,
	ToolCallEvent,
	ToolInfo,
	ToolResultEvent,
} from "./extensions/types.ts";
import type { IntegrationAccountStorage } from "./integration-account-storage.ts";
import { IntegrationRunner } from "./integrations/runner.ts";
import { loadMemory } from "./memory.ts";
import { type CustomMessage, createCustomMessage } from "./messages.ts";
import { isApiKeyLoginProvider, type ModelRegistry } from "./model-registry.ts";
import { resolveModelScope, type ScopedModel } from "./model-resolver.ts";
import type { ConfiguredPlugin } from "./plugin-manager.ts";
import { type PromptTemplate, parseCommandArgs } from "./prompt-templates.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "./resource-loader.ts";
import { listAgentSessions, openAgentSession, type SessionInfo } from "./session.ts";
import { SessionManager } from "./session-manager.ts";
import type { Skill } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { createDeployTool } from "./tools/deploy.ts";
// File tools live under tools/. memory is steward's own curated-notes tool; the
// rest — read/write/edit/ls/grep/find and bash — are wired with no overrides.
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "./tools/index.ts";
import { createMemoryTool } from "./tools/memory.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";

export interface AgentRuntimeOptions {
	name: string;
	model: Model<Api>;
	authStorage: AuthStorage;
	/**
	 * Durable per-agent model registry (auth-filtered model list + provider registration).
	 * Built once at construction and shared across every session build/reload — a session
	 * swap must not drop registered providers or re-read auth from scratch.
	 */
	modelRegistry: ModelRegistry;
	/**
	 * Per-agent integration account store. Constructed once (process-scoped) and
	 * must survive `/reload` so per-account state isn't lost.
	 */
	integrationAccounts: IntegrationAccountStorage;
}

/**
 * The interactive mode's extension surface, handed to the runtime once and re-applied to
 * every runner it builds (per-conversation swap and `/reload`).
 */
export interface InteractiveContextBindings {
	uiContext: ExtensionUIContext;
	mode: ExtensionMode;
	/**
	 * Host-provided new-session handler backing `conversation.newSession()` — applies the host's
	 * policy (e.g. the forming-agent guard) then swaps to a fresh conversation. Optional: non-interactive
	 * hosts leave it unset and `newSession()` is a no-op that reports `{ cancelled: false }`.
	 */
	newSession?: NewSessionHandler;
	onError?: ExtensionErrorListener;
	shutdownHandler?: () => void;
}

/**
 * Replace every own-key of `target` with `replacement`'s in place.
 *
 * The message_end interceptor hands extensions the same object agent-core holds in
 * its in-memory state and is about to persist. When an extension returns a replaced
 * message, mutating in place (rather than swapping the reference) keeps agent state,
 * the persisted copy, and later turn/agent events all pointing at one object.
 */
function replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
	for (const key of Object.keys(target)) {
		delete (target as unknown as Record<string, unknown>)[key];
	}
	Object.assign(target, replacement);
}

/**
 * Map steward's loaded skills/prompt templates into the shapes the harness exposes
 * for explicit invocation (`harness.skill()` / `harness.promptFromTemplate()`).
 *
 * Only skills need converting: steward's `Skill` carries just a `filePath` (the body
 * is never held in memory), so a skill's `content` is the frontmatter-stripped
 * SKILL.md body, read from disk here. Steward's `PromptTemplate` already carries
 * `content` and is structurally a harness `PromptTemplate` (extra fields are ignored),
 * so it passes straight through.
 */
function toHarnessResources(skills: Skill[], promptTemplates: PromptTemplate[]): AgentHarnessResources {
	return {
		skills: skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			content: stripFrontmatter(readFileSync(skill.filePath, "utf-8")),
			filePath: skill.filePath,
			disableModelInvocation: skill.disableModelInvocation,
		})),
		promptTemplates,
	};
}

/**
 * Scan a branch (root→leaf) from the end for the most recent compaction entry.
 * The engine persists compaction as a `compaction`-typed tree entry.
 */
function getLatestCompactionEntry(entries: SessionTreeEntry[]): SessionTreeEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i];
	}
	return null;
}

/** Extract the plain-text portion of a custom/user message content for turn delivery. */
function contentToText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Extract the image portion of a message content, or undefined when there are none. */
function contentToImages(content: string | (TextContent | ImageContent)[]): ImageContent[] | undefined {
	if (typeof content === "string") return undefined;
	const images = content.filter((c): c is ImageContent => c.type === "image");
	return images.length > 0 ? images : undefined;
}

/** One integration service: whether an account is configured, plus its action/event names. */
export interface IntegrationInfo {
	service: string;
	configured: boolean;
	actions: string[];
	events: string[];
}

/** One context document the agent reads: curated memory or a project context file. */
export interface ContextInfo {
	name: string;
	kind: "memory" | "project";
	chars: number;
}

/** The per-conversation runtime state handed to a `Conversation` at construction. */
interface ConversationInit {
	harness: AgentHarness;
	sessionManager: SessionManager;
	env: NodeExecutionEnv;
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

export class AgentRuntime {
	private readonly options: AgentRuntimeOptions;
	private _config?: AgentConfig;

	// Extension subsystem state. Each is (re)built per conversation/reload.
	private _extensionRunner?: ExtensionRunner;
	/** Integration producer runner. (Re)built per conversation; stopped before the new one starts. */
	private _integrationRunner?: IntegrationRunner;
	/**
	 * Daemon-registered sink that broadcasts a `scoped_models_update` after every scope change.
	 *
	 * TODO: this bespoke runtime→daemon callback exists only because the broadcaster subscribes to the
	 * harness, which doesn't own scoped models. Either (a) add a general runtime-level event emitter so
	 * runtime-originated events flow like harness own-events without a per-feature handler, or (b)
	 * redesign scoped models as a stateless daemon resolver with client-held state (drops this handler
	 * and the `scoped_models_update` event, trading away multi-client scope sync).
	 */
	private _scopedModelsHandler?: (scopedModels: ScopedModel[]) => void;
	/** The built-in tools, kept so refreshTools() can re-apply base + extension tools. */
	private _baseTools: AgentTool[] = [];
	/** The wrapped extension tools, kept for refreshTools(). */
	private _extensionTools: AgentTool[] = [];
	/** Skills frozen into the prompt this conversation — surfaced as skill-source commands. */
	private _skills: Skill[] = [];
	/** Prompt templates discovered this conversation — surfaced as prompt-source commands. */
	private _promptTemplates: PromptTemplate[] = [];
	/** Extensions loaded this conversation, kept for the resource summary. */
	private _extensionCount = 0;
	/** Extension load failures from the last build, surfaced in the resource summary. */
	private _loadErrors: { path: string; error: string }[] = [];
	/** Integration load + account-store parse failures from the last build, surfaced in the resource summary. */
	private _integrationLoadErrors: { path: string; error: string }[] = [];
	/** Skill name collisions from the last build, surfaced in the resource summary. */
	private _skillDiagnostics: ResourceDiagnostic[] = [];
	/** Graceful-shutdown handler installed by the host mode (default no-op). */
	private _shutdownHandler: () => void = () => {};
	/**
	 * The interactive mode's extension surface, retained so it can be re-applied to every
	 * runner the runtime builds. Undefined until `bindInteractiveContext()` runs — non-interactive
	 * hosts (print) never call it, so their runners keep the `noOpUIContext`.
	 */
	private _interactiveBindings?: InteractiveContextBindings;
	/** Teardown for the current runner's error listener, dropped before re-binding. */
	private _extensionErrorUnsubscriber?: () => void;
	/** Teardown for the integration runner's error listener, dropped before re-binding. */
	private _integrationErrorUnsubscriber?: () => void;
	/**
	 * Re-subscribe hook fired after every harness swap (`createConversation()`) and at the
	 * end of `reload()`. A headless wrapper (the daemon) registers it to re-point its event
	 * subscription at the live harness. Default undefined — interactive/print never set it.
	 */
	private _rebindHandler?: (harness: AgentHarness) => void;

	/** Durable per-agent model registry — built once, shared across every conversation build/reload. */
	private readonly _modelRegistry: ModelRegistry;
	/**
	 * Durable per-agent settings manager (identity + merged settings) — read for request-time
	 * provider-attribution headers, model/thinking defaults, and resource discovery. Built once;
	 * the writer for runtime mutations and re-read from disk on each conversation build/reload.
	 */
	private readonly _settingsManager: AgentSettingsManager;

	/** The single live conversation (N=1). Undefined until `start()`. */
	private _conversation?: Conversation;

	/**
	 * The full run-target map for the live conversation, exposed to extensions via
	 * `steward.environments`. Rebuilt each `buildResources`; undefined until the first build.
	 */
	private _environments?: AgentEnvironments;

	/**
	 * Host-provided new-session handler backing `conversation.newSession()`. Default no-op (print mode);
	 * the interactive host sets it via `bindInteractiveContext`.
	 */
	private _newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });

	constructor(options: AgentRuntimeOptions) {
		this.options = options;
		this._modelRegistry = options.modelRegistry;
		this._settingsManager = AgentSettingsManager.create(options.name);
	}

	/**
	 * The live conversation, or undefined when absent — find-only, never creates. At N=1 this is
	 * the single default conversation. The keyed form lights up with the multi-session wire.
	 */
	getConversation(): Conversation | undefined {
		return this._conversation;
	}

	/**
	 * The live conversation's full run-target map (backs `steward.environments`). Throws before the
	 * first `buildResources`. Delegated onto the shared extension runtime in `buildResources`.
	 */
	get environments(): AgentEnvironments {
		if (!this._environments) throw new Error("AgentRuntime not started.");
		return this._environments;
	}

	/** The config the live conversation was built from (re-read each build). */
	get config(): AgentConfig {
		if (!this._config) throw new Error("AgentRuntime not started.");
		return this._config;
	}

	/**
	 * The agent's live per-agent integration account store — the single writer the daemon's
	 * onboarding handler persists credentials through (no cross-process staleness).
	 */
	get integrationAccounts(): IntegrationAccountStorage {
		return this.options.integrationAccounts;
	}

	/** The live extension runner. Throws if accessed before `start()`. */
	get extensionRunner(): ExtensionRunner {
		if (!this._extensionRunner) throw new Error("AgentRuntime not started.");
		return this._extensionRunner;
	}

	// Durable state the live conversation reads off its runtime. configuredModel is agent.json's
	// model (distinct from a conversation's resumed model).
	get configuredModel(): Model<Api> {
		return this.options.model;
	}
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}
	get baseTools(): AgentTool[] {
		return this._baseTools;
	}
	get extensionTools(): AgentTool[] {
		return this._extensionTools;
	}
	get promptTemplates(): PromptTemplate[] {
		return this._promptTemplates;
	}

	/** Install the graceful-shutdown handler exposed to extensions via `steward.shutdown()`. */
	setShutdownHandler(handler: () => void): void {
		this._shutdownHandler = handler;
	}

	/** Fire the graceful-shutdown handler (backs `steward.shutdown()`). */
	shutdown(): void {
		this._shutdownHandler();
	}

	/**
	 * Register the re-subscribe hook fired after every harness swap and after `reload()`.
	 * The handler receives the live harness so a headless wrapper can drop its old event
	 * subscription and re-subscribe (unsub-old → sub-new). Called once by the daemon mode.
	 */
	setRebindHandler(handler: (harness: AgentHarness) => void): void {
		this._rebindHandler = handler;
	}

	/**
	 * Register the sink fired after every scope change, so a headless wrapper (the daemon) can
	 * broadcast a `scoped_models_update` to attached clients. Called once by the daemon mode.
	 */
	setScopedModelsHandler(handler: (scopedModels: ScopedModel[]) => void): void {
		this._scopedModelsHandler = handler;
	}

	/** Broadcast a resolved scope to the registered sink — called by the live conversation. */
	notifyScopedModels(scopedModels: ScopedModel[]): void {
		this._scopedModelsHandler?.(scopedModels);
	}

	/**
	 * Hand the interactive mode's extension surface (UI context, command-context actions,
	 * error listener, shutdown handler) to the runtime and apply it to the live runner.
	 *
	 * The bindings are retained on the runtime and re-applied by `_applyInteractiveContext` to
	 * every runner `createConversation()`/`reload()` stands up, so a rebuilt runner never reverts to
	 * `noOpUIContext`. Called once by the interactive mode after it subscribes to the runtime.
	 */
	bindInteractiveContext(bindings: InteractiveContextBindings): void {
		this._interactiveBindings = bindings;
		if (bindings.shutdownHandler) this.setShutdownHandler(bindings.shutdownHandler);
		this._applyInteractiveContext(this.extensionRunner);
	}

	/**
	 * Apply the retained interactive bindings to `runner`: set its UI context + mode, install the
	 * host new-session handler, and (re)install the error listener. No-op when no interactive mode
	 * has bound yet (the first `createConversation()` runs before `bindInteractiveContext`, leaving the
	 * runner on `noOpUIContext` until the mode binds).
	 */
	private _applyInteractiveContext(runner: ExtensionRunner): void {
		const bindings = this._interactiveBindings;
		if (!bindings) return;
		runner.setUIContext(bindings.uiContext, bindings.mode);
		this._newSessionHandler = bindings.newSession ?? (async () => ({ cancelled: false }));
		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = bindings.onError ? runner.onError(bindings.onError) : undefined;

		this._integrationErrorUnsubscriber?.();
		this._integrationErrorUnsubscriber = bindings.onError
			? this._integrationRunner?.onError(bindings.onError)
			: undefined;
	}

	/** Run the host-provided new-session handler backing `conversation.newSession()`. */
	runNewSession(options?: NewSessionOptions): Promise<{ cancelled: boolean }> {
		return this._newSessionHandler(options);
	}

	/**
	 * The dir tools operate in — the agent's home dir, where SOUL/MEMORY/USER.md
	 * and workspace/ live. The interactive mode passes this into each
	 * `ToolExecutionComponent` so its built-in renderers can reconstruct from cwd.
	 */
	getCwd(): string {
		return getAgentDir(this.options.name);
	}

	/**
	 * Live slash-command metadata — extension + prompt + skill commands, read-only. The
	 * `getCommands` action wired into `runner.bindCore` is a closure inside the conversation,
	 * unreachable from the interactive mode — which needs the same list to feed editor
	 * autocomplete. Exposed here because the interactive mode can't read these off the private
	 * harness session. Built-in interactive commands (`BUILTIN_SLASH_COMMANDS`) are layered in
	 * by the caller.
	 */
	getCommands(): SlashCommandInfo[] {
		const commands: SlashCommandInfo[] = [];
		for (const command of this.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			});
		}
		for (const template of this._promptTemplates) {
			commands.push({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			});
		}
		for (const skill of this._skills) {
			// Skills are invoked as `/skill:<name>`, disambiguating them from prompt-template
			// commands.
			commands.push({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			});
		}
		return commands;
	}

	/**
	 * Loaded-resource counts plus any load/collision diagnostics from the last build or
	 * reload. The interactive mode prints this at startup and after `/reload`.
	 */
	getResourceSummary(): ResourceSummary {
		const runner = this.extensionRunner;
		const diagnostics: ResourceDiagnostic[] = [
			...this._loadErrors.map(({ path, error }): ResourceDiagnostic => ({ type: "error", message: error, path })),
			...this._integrationLoadErrors.map(
				({ path, error }): ResourceDiagnostic => ({ type: "error", message: error, path }),
			),
			...this._skillDiagnostics,
			...runner.getCommandDiagnostics(),
		];
		return {
			extensions: this._extensionCount,
			skills: this._skills.length,
			prompts: this._promptTemplates.length,
			commands: runner.getRegisteredCommands().length,
			diagnostics,
		};
	}

	/** Granular capability lists for the agent detail page. */
	getToolInfos(): ToolInfo[] {
		const runner = this.extensionRunner;
		const harness = this.getConversation()?.harness;
		if (!harness) return [];
		const registered = new Map(runner.getAllRegisteredTools().map((rt) => [rt.definition.name, rt]));
		return harness.getTools().map((tool) => {
			const rt = registered.get(tool.name);
			if (rt) {
				return {
					name: rt.definition.name,
					description: rt.definition.description,
					parameters: rt.definition.parameters,
					promptGuidelines: rt.definition.promptGuidelines,
					sourceInfo: rt.sourceInfo,
				};
			}
			return {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: undefined,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${tool.name}>`, { source: "builtin" }),
			};
		});
	}

	getIntegrationInfos(): IntegrationInfo[] {
		return (this._integrationRunner?.getServiceCapabilities() ?? []).map((cap) => ({
			service: cap.service,
			configured: this.integrationAccounts.listAccounts(cap.service).length > 0,
			actions: cap.actions,
			events: cap.events,
		}));
	}

	getSkills(): Skill[] {
		return this._skills;
	}

	getPlugins(): ConfiguredPlugin[] {
		return createAgentPluginManager(this.config.name).pluginManager.listConfiguredPlugins();
	}

	getContextInfos(): ContextInfo[] {
		const { soul, memory, user } = loadMemory(this.config.name);
		const contexts: ContextInfo[] = [
			{ name: "SOUL.md", kind: "memory", chars: soul.length },
			{ name: "MEMORY.md", kind: "memory", chars: memory.length },
			{ name: "USER.md", kind: "memory", chars: user.length },
		];
		// The daemon's own prompt omits project context files (`noContextFiles: true`), so read
		// them standalone here for display — this does not change prompt construction.
		const projectFiles = loadProjectContextFiles({
			cwd: this.getCwd(),
			agentDir: getAgentDir(this.config.name),
		});
		for (const file of projectFiles) {
			contexts.push({ name: basename(file.path), kind: "project", chars: file.content.length });
		}
		return contexts;
	}

	/**
	 * Re-discover extensions, skills, and prompt templates in place against the live
	 * conversation — no new harness, so the conversation is preserved. Re-points the live
	 * harness at the rebuilt resources and tool set.
	 *
	 * The outgoing runner's extension flag values are carried into the new runtime so a
	 * reload does not reset extension state. The system prompt is frozen for the conversation's
	 * lifetime: the rebuilt prompt backs `ctx.getSystemPrompt()`, but the model-facing
	 * prompt only changes on the next conversation.
	 */
	async reload(): Promise<void> {
		const conversation = this.getConversation();
		if (!conversation) throw new Error("AgentRuntime not started.");
		const harness = conversation.harness;
		const previousRunner = this.extensionRunner;
		const previousIntegrationRunner = this._integrationRunner;
		const previousFlagValues = previousRunner.getFlagValues();

		// Shut the outgoing runtime down while its ctx is still valid, so extensions can
		// clean up before the new runner takes over.
		await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });

		// Re-read settings + agent.json from disk so a `/reload` picks up settings.json changes
		// (plugin sources, local resource paths) — the manager is otherwise frozen since the last build.
		this._settingsManager.reload();
		const config = this._settingsManager.config;
		const agentDir = getAgentDir(this.options.name);
		const {
			runner,
			integrationRunner,
			skills,
			promptTemplates,
			systemPrompt,
			systemPromptOptions,
			baseTools,
			extensionTools,
		} = await this.buildResources({
			config,
			agentDir,
			name: this.options.name,
			seedFlagValues: previousFlagValues,
		});
		this._config = config;
		// The model-facing prompt stays frozen this conversation; refresh the ctx-readable copy.
		conversation.systemPrompt = systemPrompt;
		conversation.systemPromptOptions = systemPromptOptions;

		// Re-point the live harness at the rebuilt resources + tools. Active selection =
		// previously-active tools that still exist, plus all extension tools (so newly
		// registered ones become active); the filter drops tools an extension removed.
		await harness.setResources(toHarnessResources(skills, promptTemplates));
		const nextToolNames = new Set([...baseTools, ...extensionTools].map((tool) => tool.name));
		const activeToolNames = [
			...new Set([
				...harness
					.getActiveTools()
					.map((tool) => tool.name)
					.filter((name) => nextToolNames.has(name)),
				...extensionTools.map((tool) => tool.name),
			]),
		];
		await harness.setTools([...baseTools, ...extensionTools], activeToolNames);

		// Bind the new runner's action surface + interactive context. The harness event
		// wiring already reads `runtime.extensionRunner` live, so it re-points at the new
		// runner without re-subscribing.
		conversation.bindExtensionCore(runner);
		// Stop the previous producer before starting the new one (see createConversation() for why).
		await previousIntegrationRunner?.stop();
		integrationRunner.bindCore();
		await integrationRunner.start();
		this._applyInteractiveContext(runner);

		if (runner.hasHandlers("session_start")) {
			await runner.emit({ type: "session_start", reason: "reload" });
		}

		previousRunner.invalidate();
		// The harness is reused across reload, so re-subscribing is a harmless no-op
		// (unsub-then-sub) — fired for symmetry with createConversation().
		this._rebindHandler?.(harness);
	}

	/** Auth-filtered models off the encapsulated registry — the single-pick selector's candidate list. */
	getAvailableModels(): Model<Api>[] {
		return this._modelRegistry.getAvailable();
	}

	/** Persist the agent-tier scoped-model shortlist (`enabledModels`) to agent.json's settings. */
	setEnabledModels(enabledModels: string[] | undefined): void {
		this._settingsManager.setEnabledModels(enabledModels);
	}

	/**
	 * Persist a model choice into this agent's own agent.json (`settings.defaultModel`), the first
	 * source the startup resolution reads, so the agent reopens on it. The shared/global default is a
	 * separate concern, set elsewhere. Called by the live conversation after switching the harness model.
	 */
	persistModel(provider: string, modelId: string): void {
		this._settingsManager.setDefaultModelAndProvider(provider, modelId);
	}

	/**
	 * Persist a thinking level as this agent's default in agent.json (`settings.defaultThinkingLevel`),
	 * so a new conversation reopens on it. Called by the live conversation, which decides whether the
	 * level actually changed.
	 */
	persistThinkingLevel(level: ThinkingLevel): void {
		this._settingsManager.setDefaultThinkingLevel(level);
	}

	/**
	 * Login-eligible providers: every OAuth provider, plus every model provider that authenticates
	 * by API key (built-in providers with a display name, or non-built-in providers without OAuth).
	 * Optionally filtered to a single auth type. Named to match coding-agent's method.
	 */
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.options.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this._modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this._modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Providers with a stored credential — the logout candidates. Named to match coding-agent's method. */
	getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.options.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this._modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Run a provider login daemon-side, prompting the client over the bound uiContext. OAuth flows
	 * open the browser on the daemon host (where local-callback-server providers bind) and route
	 * `onPrompt`/`onSelect` through the dialog seam; API-key flows read the key via `ui.input`.
	 * Refreshes the registry afterward so the new credential's models become selectable.
	 */
	async login(provider: string, authType: "oauth" | "api_key"): Promise<void> {
		const ui = this.extensionRunner.getUIContext();
		const name = this._modelRegistry.getProviderDisplayName(provider);

		if (authType === "oauth") {
			const callbacks: OAuthLoginCallbacks = {
				onAuth: (info) => {
					openBrowser(info.url);
					ui.notify(info.instructions ? `${info.url}\n${info.instructions}` : info.url);
				},
				onDeviceCode: (info) => {
					ui.notify(`Enter code ${info.userCode} at ${info.verificationUri}`);
				},
				onPrompt: async (prompt) => (await ui.input(prompt.message, prompt.placeholder)) ?? "",
				onProgress: (message) => {
					ui.setStatus("login", message);
				},
				onSelect: async (prompt: OAuthSelectPrompt) => {
					const labels = prompt.options.map((option) => option.label);
					const selectedLabel = await ui.select(prompt.message, labels);
					return prompt.options.find((option) => option.label === selectedLabel)?.id;
				},
			};
			await this.options.authStorage.login(provider as OAuthProviderId, callbacks);
		} else {
			const key = (await ui.input(`Enter API key for ${name}`))?.trim();
			if (!key) {
				throw new Error("API key cannot be empty.");
			}
			this.options.authStorage.set(provider, { type: "api_key", key });
		}

		this._modelRegistry.refresh();
	}

	/** Remove a provider's stored credential, then refresh the registry. */
	logout(provider: string): void {
		this.options.authStorage.logout(provider);
		this._modelRegistry.refresh();
	}

	/**
	 * Create a new conversation on a brand-new session and make it the live one, swapping out any
	 * previous in place. A new session keeps the agent's configured model + default thinking level.
	 *
	 * `options.setup` runs against the fresh session before it goes live (seed entries); `options.withConversation`
	 * runs against the replacement conversation once it is wired and live.
	 */
	async createConversation(options?: NewSessionOptions): Promise<Conversation> {
		const { name, model } = this.options;
		const previousConversation = this._conversation;
		const previousRunner = this._extensionRunner;
		const previousIntegrationRunner = this._integrationRunner;

		this._settingsManager.reload();
		const config = this._settingsManager.config;
		const { session, env } = await openAgentSession(name, { fresh: true });
		const metadata = await session.getMetadata();
		const sessionManager = new SessionManager(session, metadata);
		await options?.setup?.(sessionManager);
		const thinkingLevel = clampThinkingLevel(
			model,
			this._settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
		) as ThinkingLevel;

		const {
			runner,
			integrationRunner,
			skills,
			promptTemplates,
			systemPrompt,
			systemPromptOptions,
			baseTools,
			extensionTools,
		} = await this.buildResources({
			config,
			agentDir: getAgentDir(name),
			name,
		});

		// Frozen system prompt as a constant callback (prefix cache stays warm); request-time auth
		// resolves through resolveRequestAuth, closing over this session id.
		const harness = new AgentHarness({
			env,
			session,
			model,
			thinkingLevel,
			systemPrompt: () => systemPrompt,
			tools: [...baseTools, ...extensionTools],
			resources: toHarnessResources(skills, promptTemplates),
			getApiKeyAndHeaders: (requestModel) => this.resolveRequestAuth(requestModel, metadata.id),
		});
		const conversation = new Conversation(this, { harness, sessionManager, env, systemPrompt, systemPromptOptions });
		this._config = config;
		this._conversation = conversation;

		// Bind before wire so handlers firing during session_start see a fully-bound context. The
		// integration producer swaps stop-old → start-new — the reverse of the extension runner's
		// new-before-old order, since producers hold exclusive connections.
		conversation.bindExtensionCore(runner);
		await previousIntegrationRunner?.stop();
		integrationRunner.bindCore();
		await integrationRunner.start();
		this._applyInteractiveContext(runner);
		conversation.wireExtensionEvents();
		this._rebindHandler?.(harness);
		if (runner.hasHandlers("session_start")) await runner.emit({ type: "session_start", reason: "new" });

		// Tear down the superseded conversation only now, so the new env is live before the old cleans up.
		if (previousRunner) {
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "new" });
			previousRunner.invalidate();
		}
		await previousConversation?.cleanup();

		// Re-seed model scope from the merged `enabledModels` (agent override over shared default) →
		// global shortlist, so a session-only `/scope` does NOT survive `/new` — it resets to the
		// agent default (intended).
		const enabledModelIds = this._settingsManager.getEnabledModels();
		if (enabledModelIds && enabledModelIds.length > 0) await conversation.setScopedModels(enabledModelIds);

		// Hand `withConversation` the public facade for the live conversation (now bound on the runner).
		const liveConversation = runner.getConversation();
		if (liveConversation) await options?.withConversation?.(liveConversation);
		return conversation;
	}

	/**
	 * Resume a stored session as the live conversation, swapping out any previous in place. With no
	 * `id`, reopens the agent's most-recent session (the daemon does this on startup); with an `id`,
	 * reopens that specific session. Restores the session's own model + thinking level over the agent
	 * defaults (the engine reconstructs them from the branch).
	 */
	async resumeConversation(id?: string): Promise<Conversation> {
		const { name, model } = this.options;
		const previousConversation = this._conversation;
		const previousRunner = this._extensionRunner;
		const previousIntegrationRunner = this._integrationRunner;

		this._settingsManager.reload();
		const config = this._settingsManager.config;
		const { session, env } = await openAgentSession(name, id ? { id } : { fresh: false });
		const metadata = await session.getMetadata();
		const sessionManager = new SessionManager(session, metadata);

		// Restore the session's model if it still exists with configured auth, else the agent default.
		let effectiveModel = model;
		const sessionModel = buildSessionContext(sessionManager.getBranch()).model;
		if (sessionModel) {
			const restored = this._modelRegistry.find(sessionModel.provider, sessionModel.modelId);
			if (restored && this._modelRegistry.hasConfiguredAuth(restored)) effectiveModel = restored;
		}
		// Restore the session's thinking level if the branch pinned one, else the agent default.
		const sessionThinking = sessionManager.getBranch().some((e) => e.type === "thinking_level_change")
			? (buildSessionContext(sessionManager.getBranch()).thinkingLevel as ThinkingLevel)
			: (this._settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
		const thinkingLevel = clampThinkingLevel(effectiveModel, sessionThinking) as ThinkingLevel;

		const {
			runner,
			integrationRunner,
			skills,
			promptTemplates,
			systemPrompt,
			systemPromptOptions,
			baseTools,
			extensionTools,
		} = await this.buildResources({
			config,
			agentDir: getAgentDir(name),
			name,
		});

		const harness = new AgentHarness({
			env,
			session,
			model: effectiveModel,
			thinkingLevel,
			systemPrompt: () => systemPrompt,
			tools: [...baseTools, ...extensionTools],
			resources: toHarnessResources(skills, promptTemplates),
			getApiKeyAndHeaders: (requestModel) => this.resolveRequestAuth(requestModel, metadata.id),
		});
		const conversation = new Conversation(this, { harness, sessionManager, env, systemPrompt, systemPromptOptions });
		this._config = config;
		this._conversation = conversation;

		conversation.bindExtensionCore(runner);
		await previousIntegrationRunner?.stop();
		integrationRunner.bindCore();
		await integrationRunner.start();
		this._applyInteractiveContext(runner);
		conversation.wireExtensionEvents();
		this._rebindHandler?.(harness);
		if (runner.hasHandlers("session_start")) await runner.emit({ type: "session_start", reason: "startup" });

		if (previousRunner) {
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "new" });
			previousRunner.invalidate();
		}
		await previousConversation?.cleanup();

		const enabledModelIds = this._settingsManager.getEnabledModels();
		if (enabledModelIds && enabledModelIds.length > 0) await conversation.setScopedModels(enabledModelIds);
		return conversation;
	}

	/** Stored sessions for this agent (newest first) — the ids `resumeConversation(id)` accepts. */
	listSessions(): Promise<SessionInfo[]> {
		return listAgentSessions(this.options.name);
	}

	/**
	 * Resolve request-time auth + provider-attribution headers via the model registry (not straight off
	 * AuthStorage — this path carries custom models.json keys + per-model/provider headers). The harness
	 * contract is `apiKey: string`, so a keyless provider is rejected. `sessionId` rides the headers.
	 */
	private async resolveRequestAuth(
		model: Model<Api>,
		sessionId: string,
	): Promise<{ apiKey: string; headers?: Record<string, string> }> {
		const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey) throw new Error(`No API key for "${model.provider}"`);
		return {
			apiKey: auth.apiKey,
			headers: mergeProviderAttributionHeaders(model, this._settingsManager, sessionId, auth.headers),
		};
	}

	/**
	 * Discover + load extensions, build the runner, surface discovered skill/prompt
	 * paths into freshly-loaded resources, freeze the system prompt, and assemble the
	 * base + extension tool set. Shared by `createConversation()` (per-conversation) and `reload()`
	 * (in-place, against the live conversation). Mutates the runtime resource state
	 * (`_extensionRunner`, `_skills`, `_promptTemplates`, `_baseTools`, `_extensionTools`,
	 * diagnostics) and returns the pieces the caller needs to stand up or re-point the
	 * harness — including the frozen `systemPrompt(+Options)`, which the caller assigns to
	 * the conversation.
	 *
	 * `seedFlagValues` carries an outgoing runner's extension flag values into the new
	 * runtime (reload only) — `createConversation()` starts a new conversation and leaves flags at their
	 * defaults.
	 */
	private async buildResources(params: {
		config: AgentConfig;
		agentDir: string;
		name: string;
		seedFlagValues?: Map<string, boolean | string>;
	}): Promise<{
		runner: ExtensionRunner;
		integrationRunner: IntegrationRunner;
		skills: Skill[];
		promptTemplates: PromptTemplate[];
		systemPrompt: string;
		systemPromptOptions: BuildSystemPromptOptions;
		baseTools: AgentTool[];
		extensionTools: AgentTool[];
		errors: { path: string; error: string }[];
	}> {
		const { config, agentDir, name, seedFlagValues } = params;
		const integrationAccounts = this.options.integrationAccounts;
		// Settings + agent.json were re-read from disk by the caller (createConversation/
		// resumeConversation/reload) right before this build, so the manager is current here.

		// One resource loader owns npm/git/local install + resolution and resolves extensions
		// AND integrations in place from the same per-agent home (cwd = agentDir; there is no
		// project-local resource concept — each agent owns its resources under its home). It
		// builds the *unbound* IntegrationRunner via the hook below (which the loader threads
		// into the extension loader so extensions wire `getIntegration` at load time); this
		// runtime keeps the runner's stop-before-start lifecycle (see createConversation()/reload()). The
		// integration arm resolves BEFORE the extension arm inside reload(). The account store
		// is process-scoped (survives reload).
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: this._settingsManager,
			// The interactive mode owns theme + context-file loading; the runtime only needs
			// extensions/integrations/skills/prompts from the loader.
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload({
			buildIntegrationRunner: ({ integrations, runtime }) =>
				new IntegrationRunner(integrations, runtime, agentDir, integrationAccounts),
		});

		const integrationRunner = loader.getIntegrationRunner();
		if (!integrationRunner) {
			throw new Error("Resource loader did not build an integration runner");
		}
		this._integrationRunner = integrationRunner;
		// Surface integration load failures + account-store parse failures (e.g. a malformed
		// integrations.json that would otherwise silently yield zero accounts) through the
		// resource-summary diagnostics path, alongside the extension load errors below.
		this._integrationLoadErrors = [
			...loader.getIntegrations().errors,
			...integrationAccounts
				.drainErrors()
				.map((error) => ({ path: getAgentIntegrationsPath(name), error: error.message })),
		];

		// This runtime owns the approval policy (store + gate); the gate reads `getUI` lazily, so
		// `runner` below is in scope by the time it runs mid-tool-call. The default target's env
		// backs the file tools + ctx.environment; `environments` carries the full map to bash.
		const approvals = ApprovalStore.create(name);
		const gate = createApprovalGate(() => runner.getUIContext(), approvals);
		// Daemon-owned control state, write-denied to the agent's own tools on the confined target so it
		// can't self-approve a host escalation or tamper with session history. (agent.json stays writable.)
		const controlState = [getAgentApprovalsPath(name), getSessionsDir(name)];
		const environments = await createEnvironments(agentDir, { gate, denyWrite: controlState });
		this._environments = environments;
		const defaultEnv = environments.targets[environments.default];
		const { extensions, errors, runtime } = loader.getExtensions();
		// Wire the agent-global `steward.*` delegates onto the shared extension runtime. Closures over
		// `this` (the durable AgentRuntime) — the same bridge the per-conversation actions ride, set here
		// where `this` is in scope rather than threaded through the runner.
		// `steward.getConversation()/createConversation()` expose the public `Conversation` facade
		// (built in bindExtensionCore, held by the runner), not the internal Conversation class.
		runtime.getConversation = () => this.extensionRunner.getConversation();
		runtime.createConversation = async () => {
			await this.createConversation();
			const conversation = this.extensionRunner.getConversation();
			if (!conversation) throw new Error("createConversation produced no bound conversation");
			return conversation;
		};
		runtime.listSessions = () => this.listSessions();
		runtime.reload = () => this.reload();
		runtime.shutdown = () => this.shutdown();
		runtime.getModelRegistry = () => this._modelRegistry;
		runtime.getEnvironments = () => this.environments;
		const runner = new ExtensionRunner(extensions, runtime, this._modelRegistry);
		this._extensionRunner = runner;
		this._extensionCount = extensions.length;
		this._loadErrors = errors;
		// Carry an outgoing runner's flag values into the new runtime (reload only).
		if (seedFlagValues) {
			for (const [flag, value] of seedFlagValues) runner.setFlagValue(flag, value);
		}
		// Surface load errors through the runner's error channel (no listeners yet at
		// build time → silent: the host mode attaches a listener later).
		for (const { path, error } of errors) {
			runner.emitError({ path, event: "load", error });
		}

		// Read curated files ONCE and freeze them into the prompt. Mid-session edits
		// (memory tool / file tools) persist to disk but only enter the prompt next conversation.
		const { soul, memory, user } = loadMemory(name);
		const { skills, diagnostics: skillDiagnostics } = loader.getSkills();
		this._skillDiagnostics = skillDiagnostics;
		const promptTemplates = loader.getPrompts().prompts;
		this._skills = skills;
		this._promptTemplates = promptTemplates;

		// Tools operate in the agent's home dir, where SOUL/MEMORY/USER.md and the
		// workspace/ subdir live. memory is steward's curated-notes tool; the rest
		// are read/write/edit/ls/grep/find plus bash, all routed through the default
		// target's environment (registerTool tools reach the same instance via ctx.environment).
		const baseTools: AgentTool[] = [
			createMemoryTool(name),
			// The deploy tool only exists while forming — the agent uses it to author
			// its purpose + SOUL.md and ask to be deployed. Once deployed it has served
			// its purpose and is omitted.
			...(isDeployed(config) ? [] : [createDeployTool(name)]),
			createReadTool(defaultEnv),
			createWriteTool(defaultEnv),
			createEditTool(defaultEnv),
			createLsTool(defaultEnv),
			createGrepTool(defaultEnv),
			createFindTool(defaultEnv),
			// Only bash gets the target map; the rest stay on the default target.
			createBashTool(defaultEnv, { environments }),
		];
		// Wrap each extension-registered tool into an engine AgentTool. The context
		// factory is lazy (`runner.createContext()`) so it resolves the live binding
		// at execution time — tools only execute mid-turn, after bindCore() has run.
		const extensionTools: AgentTool[] = runner
			.getAllRegisteredTools()
			.map((rt) => wrapToolDefinition(rt.definition, () => runner.createContext()));
		this._baseTools = baseTools;
		this._extensionTools = extensionTools;

		// Skills are appended to the frozen prompt. The structured options
		// are retained so extensions can read them via ctx.getSystemPromptOptions().
		const selectedTools = [...baseTools, ...extensionTools].map((t) => t.name);
		const systemPromptOptions: BuildSystemPromptOptions = {
			config,
			cwd: agentDir,
			soul,
			memory,
			user,
			skills,
			selectedTools,
		};
		const systemPrompt = buildSystemPrompt(systemPromptOptions);

		return {
			runner,
			integrationRunner,
			skills,
			promptTemplates,
			systemPrompt,
			systemPromptOptions,
			baseTools,
			extensionTools,
			errors,
		};
	}

	/**
	 * Release the runtime: stop integration producers, clean up the live conversation (its env +
	 * wiring), then tear down the process-global sandbox. Best-effort.
	 */
	async cleanup(): Promise<void> {
		// Stop live integration producers at process exit — they hold real connections.
		await this._integrationRunner?.stop();
		// Clean up the live conversation's env + event wiring.
		await this._conversation?.cleanup();
		this._conversation = undefined;
		// Tear down the process-global srt singleton (proxy servers + OS profile) and stop this
		// agent's docker sandbox container. Both are no-ops when their backend never ran. Only the
		// runtime runs these — a single conversation cleanup never touches process-global sandbox.
		await resetSandbox();
		await stopContainer(getAgentDir(this.options.name));
	}
}

/**
 * A single live conversation: the per-conversation half of an agent's runtime. Owns the
 * `AgentHarness`, the `SessionManager`, the execution env, the frozen system prompt, and
 * the transient turn state, plus the dispatch pipeline and the harness↔extension event
 * wiring. Reads the durable/shared half (runner, registry, tools) off its `AgentRuntime`.
 */
export class Conversation {
	readonly harness: AgentHarness;
	readonly sessionManager: SessionManager;
	private readonly env: NodeExecutionEnv;
	/** The frozen system prompt, backing `ctx.getSystemPrompt()`. Refreshed (ctx copy only) on reload. */
	systemPrompt: string;
	/** The options the frozen prompt was built from, backing `ctx.getSystemPromptOptions()`. */
	systemPromptOptions: BuildSystemPromptOptions;
	/** The current run's abort signal, or undefined when idle. */
	private _currentSignal?: AbortSignal;
	/** Queued-message count (steer+followUp+nextTurn), kept in sync via queue_update. */
	private _pendingMessageCount = 0;
	/** Turn counter — the engine's turn_start/turn_end carry no index, so we synthesize one. */
	private _turnIndex = 0;
	/** Conversation-only model shortlist, resolved against the runtime registry. */
	private _scopedModels: ScopedModel[] = [];
	/** Teardown fns for this conversation's harness event wiring (subscribe + on + onMessageEnd). */
	private _unsubscribe: (() => void)[] = [];
	/** The owning runtime — source of the shared runner, registry, tools, and persistence. */
	private readonly runtime: AgentRuntime;

	constructor(runtime: AgentRuntime, init: ConversationInit) {
		this.runtime = runtime;
		this.harness = init.harness;
		this.sessionManager = init.sessionManager;
		this.env = init.env;
		this.systemPrompt = init.systemPrompt;
		this.systemPromptOptions = init.systemPromptOptions;
	}

	/**
	 * Persist a minimal assistant message into the current session (e.g. the
	 * seeded "What is my purpose?" that opens a forming agent's first chat) and
	 * return it so the caller can also render it. The field shape: api/provider/model
	 * from the agent's configured model, zeroed `usage`, a "stop" stopReason, and a single
	 * text content block.
	 */
	async seedAssistantMessage(text: string): Promise<AssistantMessage> {
		const model = this.runtime.configuredModel;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		await this.harness.appendMessage(message);
		return message;
	}

	/**
	 * Submit user input through the full command pipeline, then hand off to the harness.
	 *
	 * Ordering:
	 *  1. extension command (`/name args`) — runs immediately, even mid-stream;
	 *  2. `input` hook — extensions may intercept (`handled`) or rewrite (`transform`);
	 *  3. skill / prompt-template dispatch — routed through `AgentHarness` resources;
	 *  4. plain prompt — or `steer`/`followUp` when a turn is already streaming.
	 *
	 * `images` stays plumbed through (default undefined) so an `input` transform can
	 * inject images even though the interactive caller passes none.
	 */
	async prompt(text: string, options?: ConversationPromptOptions): Promise<void> {
		const runner = this.runtime.extensionRunner;
		const harness = this.harness;
		const expandPromptTemplates = options?.expandPromptTemplates !== false;
		const preflight = options?.preflightResult;

		// 1. Extension command — manages its own LLM interaction via steward.sendMessage().
		if (expandPromptTemplates && text.startsWith("/") && (await this.tryExecuteExtensionCommand(text))) {
			preflight?.(true);
			return;
		}

		// 2. `input` hook — interception/transform before skill/template expansion.
		let currentText = text;
		let currentImages = options?.images;
		if (runner.hasHandlers("input")) {
			const result = await runner.emitInput(
				currentText,
				currentImages,
				options?.source ?? "interactive",
				!harness.isIdle ? options?.streamingBehavior : undefined,
			);
			if (result.action === "handled") {
				preflight?.(true);
				return;
			}
			if (result.action === "transform") {
				currentText = result.text;
				currentImages = result.images ?? currentImages;
			}
		}

		// 3. Skill / prompt-template dispatch. `/skill:<name> [args]` → harness.skill;
		//    `/<name> [args]` matching a loaded template → harness.promptFromTemplate.
		if (expandPromptTemplates && currentText.startsWith("/skill:")) {
			const spaceIndex = currentText.indexOf(" ");
			const name = spaceIndex === -1 ? currentText.slice(7) : currentText.slice(7, spaceIndex);
			const args = spaceIndex === -1 ? "" : currentText.slice(spaceIndex + 1).trim();
			preflight?.(true);
			await harness.skill(name, args || undefined);
			return;
		}
		if (expandPromptTemplates && currentText.startsWith("/")) {
			const spaceIndex = currentText.indexOf(" ");
			const name = spaceIndex === -1 ? currentText.slice(1) : currentText.slice(1, spaceIndex);
			const template = this.runtime.promptTemplates.find((t) => t.name === name);
			if (template) {
				const argv = parseCommandArgs(spaceIndex === -1 ? "" : currentText.slice(spaceIndex + 1));
				preflight?.(true);
				await harness.promptFromTemplate(name, argv);
				return;
			}
		}

		// 4. Plain prompt — or queue via steer()/followUp() when a turn is streaming.
		//    An ambiguous mid-stream submit (no streamingBehavior) is rejected rather
		//    than silently steered.
		if (!harness.isIdle) {
			if (!options?.streamingBehavior) {
				preflight?.(false);
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			preflight?.(true);
			if (options.streamingBehavior === "followUp") {
				await harness.followUp(currentText, { images: currentImages });
			} else {
				await harness.steer(currentText, { images: currentImages });
			}
			return;
		}
		// The whole turn rides `harness.prompt`, which only resolves at turn end — ack
		// acceptance now so a headless caller isn't blocked until the turn completes.
		preflight?.(true);
		await harness.prompt(currentText, { images: currentImages });
	}

	/**
	 * Send a user message to the agent (extension-driven). Always triggers a turn; while a turn
	 * is streaming, `deliverAs` selects the queue. Routes through `prompt` with command +
	 * skill/template dispatch skipped (`expandPromptTemplates: false`).
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		const text = contentToText(content);
		const images = contentToImages(content);
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Deliver an extension custom-message:
	 *  - `deliverAs: "nextTurn"` → queue for the next turn;
	 *  - else streaming (`!harness.isIdle`) → steer/followUp by `deliverAs`;
	 *  - else `triggerTurn` → drive a fresh turn (delivered as a user-role turn exactly once;
	 *    the customType/details/renderer are not applied on this path);
	 *  - else → persist a custom_message entry, which both delivers it into the next turn's
	 *    context and renders it via a registered message renderer.
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const harness = this.harness;
		const text = contentToText(message.content);
		const images = contentToImages(message.content);
		if (options?.deliverAs === "nextTurn") {
			await harness.nextTurn(text, { images });
		} else if (!harness.isIdle) {
			if (options?.deliverAs === "steer") await harness.steer(text, { images });
			else await harness.followUp(text, { images });
		} else if (options?.triggerTurn) {
			await this.prompt(text, { expandPromptTemplates: false, images, source: "extension" });
		} else {
			await this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		}
	}

	/**
	 * Clear the queued (steer + follow-up) messages without aborting the running turn and
	 * return them, so the interactive mode can restore them to the editor (dequeue).
	 */
	async clearQueue(): Promise<{ steering: AgentMessage[]; followUp: AgentMessage[] }> {
		const { steer, followUp } = await this.harness.clearQueue();
		return { steering: steer, followUp };
	}

	/** Pending steer-queued messages (read-only snapshot). */
	getSteeringMessages(): AgentMessage[] {
		return this.harness.getSteeringMessages();
	}

	/** Pending follow-up-queued messages (read-only snapshot). */
	getFollowUpMessages(): AgentMessage[] {
		return this.harness.getFollowUpMessages();
	}

	/** Number of queued messages (steer + follow-up + next-turn), kept in sync via queue_update. */
	getPendingMessageCount(): number {
		return this._pendingMessageCount;
	}

	/**
	 * Live session entries (read-only) — the interactive `/compact` guard counts
	 * messages from these. Exposed because `AgentHarness` keeps its `session`
	 * private, so the interactive mode can't read entries off the harness directly.
	 */
	getEntries(): SessionTreeEntry[] {
		return this.sessionManager.getEntries();
	}

	/**
	 * Flatten the current branch into a render-ready `SessionContext` (the aligned
	 * messages the interactive mode paints on resume). Reuses the engine's own
	 * `buildSessionContext` over steward's `SessionManager` adapter — `getBranch()`
	 * is exactly the leaf→root `SessionTreeEntry[]` the helper consumes. Exposed for the
	 * same reason as `getEntries`: the harness keeps its `session` private, so the
	 * interactive mode can't reach the engine's `Session.buildContext()` directly.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.sessionManager.getBranch());
	}

	/** The live session's id (the JSONL session file's id). */
	getSessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** The live session's display name, or undefined when unnamed. */
	getSessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Path to the live session's JSONL file, or undefined when not yet persisted. */
	getSessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/**
	 * Resolve a model by `{provider, modelId}` off the runtime registry and switch this
	 * conversation's harness to it. Throws on an unknown or unauthenticated model. Keeps the
	 * registry private — the daemon only ever holds the wire `{provider, modelId}` pair.
	 */
	async setModelById(provider: string, modelId: string): Promise<Model<Api>> {
		const modelRegistry = this.runtime.modelRegistry;
		const model = modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		if (!modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No configured credentials for ${provider}/${modelId}.`);
		}
		await this.harness.setModel(model);
		this.runtime.persistModel(provider, modelId);
		return model;
	}

	/**
	 * Switch this conversation's thinking level and persist it as the agent default. Only writes
	 * back when the level actually changes; the `level !== "off"` clause keeps a non-reasoning
	 * model from pinning "off" as the default while still letting an explicit non-off pick persist.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const previous = this.harness.getThinkingLevel();
		await this.harness.setThinkingLevel(level);
		if (level !== previous && (this.harness.getModel().reasoning || level !== "off")) {
			this.runtime.persistThinkingLevel(level);
		}
	}

	/** This conversation's resolved model shortlist (empty = no scope). */
	getScopedModels(): ScopedModel[] {
		return this._scopedModels;
	}

	/**
	 * Switch this conversation's model scope. The patterns are resolved against the runtime
	 * registry (`[]` clears the scope), then the runtime broadcasts the resolved list to clients.
	 */
	async setScopedModels(enabledModelIds: string[]): Promise<void> {
		this._scopedModels =
			enabledModelIds.length > 0 ? await resolveModelScope(enabledModelIds, this.runtime.modelRegistry) : [];
		this.runtime.notifyScopedModels(this._scopedModels);
	}

	/**
	 * Run a leading-slash extension command if one matches. Returns true when a command
	 * handled the input (so the caller sends nothing to the model).
	 */
	private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		const runner = this.runtime.extensionRunner;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = runner.getCommand(commandName);
		if (!command) return false;

		const ctx = runner.createContext();
		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			runner.emitError({
				path: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Derive context-window usage for the active model from the engine's branch entries +
	 * the `@opsyhq/agent` compaction helpers. Returns `{tokens:null,...}` right after a
	 * compaction (before the next assistant response re-establishes a usage figure).
	 */
	private computeContextUsage(): ContextUsage | undefined {
		const model = this.harness.getModel();
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		if (latestCompaction) {
			const compactionIndex = branchEntries.findIndex((e) => e.id === latestCompaction.id);
			let hasPostCompactionUsage = false;
			for (let i = compactionIndex + 1; i < branchEntries.length; i++) {
				const entry = branchEntries[i];
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (message.role !== "assistant") continue;
				if (message.stopReason === "aborted" || message.stopReason === "error") continue;
				if (calculateContextTokens(message.usage) > 0) {
					hasPostCompactionUsage = true;
					break;
				}
			}
			// Compacted but no usable post-compaction assistant usage yet → tokens unknown.
			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const messages: AgentMessage[] = [];
		for (const entry of branchEntries) {
			if (entry.type === "message") messages.push(entry.message);
		}
		const estimate = estimateContextTokens(messages);
		const percent = (estimate.tokens / contextWindow) * 100;
		return { tokens: estimate.tokens, contextWindow, percent };
	}

	/**
	 * Construct the public `Conversation` object handed to every handler/tool/command and bind it to
	 * the runner via `runner.bindConversation()`. The object is a curated facade over this conversation:
	 * closures/getters close over `this` (the explicit target conversation) plus the captured harness /
	 * runtime-shared resources, so a `reload()` re-binding the fresh runner stays tied to this
	 * conversation with no ambient "current". `ui`/`mode`/`hasUI`/`model`/`signal` are getters so they
	 * read live through the runner / harness rather than freezing at bind time. Binding also flushes any
	 * queued `steward.registerProvider(...)` calls (see `runner.bindConversation`).
	 */
	bindExtensionCore(runner: ExtensionRunner): void {
		const self = this;
		const harness = this.harness;
		const sessionManager = this.sessionManager;
		const runtime = this.runtime;
		const modelRegistry = runtime.modelRegistry;
		const cwd = runtime.getCwd();

		const conversation: ConversationApi = {
			get ui() {
				return runner.getUIContext();
			},
			get mode() {
				return runner.getMode();
			},
			get hasUI() {
				return runner.hasUI();
			},
			sessionManager,
			get model() {
				return harness.getModel();
			},
			get signal() {
				return self._currentSignal;
			},

			prompt: (text, options) => this.prompt(text, options),
			sendMessage: (message, options) => this.sendCustomMessage(message, options),
			sendUserMessage: (content, options) => this.sendUserMessage(content, options),
			appendEntry: (customType, data) => {
				void sessionManager.appendCustomEntry(customType, data);
			},

			isIdle: () => harness.isIdle,
			waitForIdle: () => harness.waitForIdle(),
			abort: () => harness.abort(),
			getPendingMessageCount: () => this.getPendingMessageCount(),
			hasPendingMessages: () => this._pendingMessageCount > 0,

			compact: (options) => {
				void harness
					.compact(options?.customInstructions)
					.then((result) => options?.onComplete?.(result))
					.catch((error) => options?.onError?.(error instanceof Error ? error : new Error(String(error))));
			},
			getContextUsage: () => this.computeContextUsage(),
			getSystemPrompt: () => this.systemPrompt,
			getSystemPromptOptions: () => this.systemPromptOptions ?? { cwd },

			getActiveTools: () => harness.getActiveTools().map((tool) => tool.name),
			setActiveTools: (toolNames) => {
				void harness.setActiveTools(toolNames);
			},
			getAllTools: () => runtime.getToolInfos(),
			getCommands: () => runtime.getCommands(),
			refreshTools: () => {
				const active = harness.getActiveTools().map((tool) => tool.name);
				void harness.setTools([...runtime.baseTools, ...runtime.extensionTools], active);
			},

			setModel: async (nextModel) => {
				if (!modelRegistry.hasConfiguredAuth(nextModel)) return false;
				await harness.setModel(nextModel);
				return true;
			},
			setModelById: (provider, modelId) => this.setModelById(provider, modelId),
			getThinkingLevel: () => harness.getThinkingLevel(),
			setThinkingLevel: (level) => this.setThinkingLevel(level),

			getSessionName: () => sessionManager.getSessionName(),
			setSessionName: (sessionName) => {
				void sessionManager.appendSessionInfo(sessionName);
			},
			setLabel: (entryId, label) => {
				void sessionManager.appendLabelChange(entryId, label);
			},

			newSession: (options) => runtime.runNewSession(options),
			reload: () => runtime.reload(),
		};

		runner.bindConversation(conversation);
	}

	/**
	 * Translate this conversation's harness events into extension `ExtensionEvent`s, storing the
	 * teardown fns on `this._unsubscribe`. See the three-way split documented at the top of the file.
	 *
	 * Every handler reads `runtime.extensionRunner` (the live getter) rather than capturing a
	 * `runner` argument: the harness outlives a reload but `_extensionRunner` is swapped in
	 * `buildResources`, so reading it at event time re-points wiring at the fresh runner without
	 * re-subscribing.
	 */
	wireExtensionEvents(): void {
		const harness = this.harness;
		const runtime = this.runtime;
		const unsubscribe: (() => void)[] = [];

		// (b) subscribe() — receives ALL events (AgentEvent + harness own-events). It
		// keeps conversation streaming/turn/queue state in sync and emits the lifecycle
		// ExtensionEvents. message_end is intentionally skipped (see (c)).
		unsubscribe.push(
			harness.subscribe(async (event, signal) => {
				const runner = runtime.extensionRunner;
				switch (event.type) {
					case "agent_start": {
						// The run's abort signal rides every dispatch — capture it for ctx.signal.
						this._currentSignal = signal;
						this._turnIndex = 0;
						if (runner.hasHandlers("agent_start")) await runner.emit({ type: "agent_start" });
						return;
					}
					case "agent_end": {
						this._currentSignal = undefined;
						if (runner.hasHandlers("agent_end")) {
							await runner.emit({ type: "agent_end", messages: event.messages });
						}
						return;
					}
					case "turn_start": {
						// The engine's turn_start carries no index/timestamp — synthesize both.
						if (runner.hasHandlers("turn_start")) {
							await runner.emit({ type: "turn_start", turnIndex: this._turnIndex, timestamp: Date.now() });
						}
						return;
					}
					case "turn_end": {
						if (runner.hasHandlers("turn_end")) {
							await runner.emit({
								type: "turn_end",
								turnIndex: this._turnIndex,
								message: event.message,
								toolResults: event.toolResults,
							});
						}
						this._turnIndex++;
						return;
					}
					case "message_start": {
						if (runner.hasHandlers("message_start")) {
							await runner.emit({ type: "message_start", message: event.message });
						}
						return;
					}
					case "message_update": {
						if (runner.hasHandlers("message_update")) {
							await runner.emit({
								type: "message_update",
								message: event.message,
								assistantMessageEvent: event.assistantMessageEvent,
							});
						}
						return;
					}
					case "message_end":
						// Handled on the onMessageEnd() interceptor (c) so mutations persist.
						return;
					case "tool_execution_start": {
						if (runner.hasHandlers("tool_execution_start")) {
							await runner.emit({
								type: "tool_execution_start",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: event.args,
							});
						}
						return;
					}
					case "tool_execution_update": {
						if (runner.hasHandlers("tool_execution_update")) {
							await runner.emit({
								type: "tool_execution_update",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: event.args,
								partialResult: event.partialResult,
							});
						}
						return;
					}
					case "tool_execution_end": {
						if (runner.hasHandlers("tool_execution_end")) {
							await runner.emit({
								type: "tool_execution_end",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								result: event.result,
								isError: event.isError,
							});
						}
						return;
					}
					case "queue_update": {
						// Own-event: keep the queued-message count in sync for ctx.hasPendingMessages().
						this._pendingMessageCount = event.steer.length + event.followUp.length + event.nextTurn.length;
						return;
					}
					case "model_update": {
						if (runner.hasHandlers("model_select")) {
							await runner.emit({
								type: "model_select",
								model: event.model,
								previousModel: event.previousModel,
								source: event.source,
							});
						}
						return;
					}
					case "thinking_level_update": {
						if (runner.hasHandlers("thinking_level_select")) {
							await runner.emit({
								type: "thinking_level_select",
								level: event.level,
								previousLevel: event.previousLevel,
							});
						}
						return;
					}
					default:
						// Other own-events (save_point, settled, abort, tools_update,
						// resources_update, before_*) have no lifecycle ExtensionEvent or are
						// delivered via native on() hooks below — ignore here.
						return;
				}
			}),
		);

		// (a) Native mutating hooks. Registered unconditionally; each guards on
		// hasHandlers() at call time. Casts bridge the engine event objects to the
		// extension event unions (structurally identical; identity preserved so
		// in-place input mutations on tool_call propagate back to the engine).
		unsubscribe.push(
			harness.on("tool_call", async (event) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("tool_call")) return undefined;
				return runner.emitToolCall(event as unknown as ToolCallEvent);
			}),
		);
		unsubscribe.push(
			harness.on("tool_result", async (event) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("tool_result")) return undefined;
				return runner.emitToolResult(event as unknown as ToolResultEvent);
			}),
		);
		unsubscribe.push(
			harness.on("context", async (event) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("context")) return undefined;
				const messages = await runner.emitContext(event.messages);
				return { messages };
			}),
		);
		unsubscribe.push(
			harness.on("before_provider_payload", async (event) => {
				const runner = runtime.extensionRunner;
				// Maps to the extension `before_provider_request` event.
				if (!runner.hasHandlers("before_provider_request")) return undefined;
				const payload = await runner.emitBeforeProviderRequest(event.payload);
				return { payload };
			}),
		);
		unsubscribe.push(
			harness.on("before_agent_start", async (event) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("before_agent_start")) return undefined;
				const result = await runner.emitBeforeAgentStart(event.prompt, event.images, event.systemPrompt);
				if (!result) return undefined;
				// Convert the returned Pick<CustomMessage,...>[] into AgentMessage[].
				const messages = result.messages?.map((m) =>
					createCustomMessage(m.customType, m.content, m.display, m.details, new Date().toISOString()),
				);
				return { messages, systemPrompt: result.systemPrompt };
			}),
		);
		unsubscribe.push(
			harness.on("session_before_compact", async (event) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("session_before_compact")) return undefined;
				return runner.emit({
					type: "session_before_compact",
					preparation: event.preparation,
					branchEntries: event.branchEntries,
					customInstructions: event.customInstructions,
					signal: event.signal,
				});
			}),
		);

		// (c) message_end interceptor. The engine runs this before persisting the
		// finalized message; an extension may return a same-role replacement, which we
		// apply in place so agent state + the persisted copy stay one object.
		unsubscribe.push(
			harness.onMessageEnd(async (message) => {
				const runner = runtime.extensionRunner;
				if (!runner.hasHandlers("message_end")) return;
				const replacement = await runner.emitMessageEnd({ type: "message_end", message });
				if (replacement && replacement !== message) {
					replaceMessageInPlace(message, replacement);
				}
			}),
		);

		this._unsubscribe = unsubscribe;
	}

	/**
	 * Drop this conversation's harness event wiring and release its env. Best-effort. Only the
	 * runtime's `cleanup()` runs the process-global sandbox teardown — cleaning up one conversation
	 * never touches it.
	 */
	async cleanup(): Promise<void> {
		for (const unsubscribe of this._unsubscribe) {
			try {
				unsubscribe();
			} catch {
				/* listener already detached with the discarded harness */
			}
		}
		this._unsubscribe = [];
		await this.env.cleanup();
	}
}
