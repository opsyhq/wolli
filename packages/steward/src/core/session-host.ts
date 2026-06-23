/**
 * Session host — owns building and swapping an agent's session/harness.
 *
 * It is the single home for the session lifecycle: it resolves the env,
 * freezes the system prompt, wires the tools, and on
 * `newSession()` tears the current env down and builds a fresh harness. The
 * interactive mode holds a `SessionHost` and calls `newSession()` to swap in
 * place — required because the system prompt is frozen for a session's lifetime,
 * so a transition that must change the prompt (the birth instruction dropping at
 * deploy) needs a new harness.
 *
 * `build()` is also the landing site for the extension subsystem: it discovers +
 * loads extensions, builds the `ExtensionRunner`, surfaces discovered skills into
 * the frozen prompt, registers extension tools alongside the built-ins, binds the
 * `steward.*`/`ctx.*` action surface to the live harness, and translates the harness's
 * events into extension `ExtensionEvent`s.
 *
 * The harness exposes a dual event mechanism, so the emission is split three ways:
 *  (a) `harness.on(type)` native mutating hooks — tool_call, tool_result, context,
 *      before_agent_start, before_provider_payload, session_before_compact;
 *  (b) `harness.subscribe()` — a translator from `AgentEvent`/own-events to the
 *      lifecycle `ExtensionEvent`s (agent/turn/message/tool-exec, model/thinking);
 *  (c) `harness.onMessageEnd()` — the message_end interceptor (the engine discards
 *      return values from subscribe/on for message_end and persists on the
 *      interceptor path, so a mutating message_end must ride that seam).
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
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
	type AgentHarness,
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
import { type AgentConfig, isDeployed, loadAgentConfig, saveAgentConfig } from "./agent-config.ts";
import { createAgentPluginManager } from "./agent-plugin-manager.ts";
import { createApprovalGate } from "./approval/approval-gate.ts";
import { ApprovalStore } from "./approval/approval-storage.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ResourceDiagnostic, ResourceSummary } from "./diagnostics.ts";
import { createEnvironments, resetSandbox, stopContainer } from "./environments/index.ts";
import { type ExtensionErrorListener, ExtensionRunner, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type {
	ContextUsage,
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionMode,
	ExtensionUIContext,
	InputSource,
	ToolCallEvent,
	ToolInfo,
	ToolResultEvent,
} from "./extensions/types.ts";
import type { IntegrationAccountStorage } from "./integration-account-storage.ts";
import { IntegrationRunner } from "./integrations/runner.ts";
import { loadMemory } from "./memory.ts";
import { type CustomMessage, createCustomMessage } from "./messages.ts";
import { isApiKeyLoginProvider, ModelRegistry } from "./model-registry.ts";
import { resolveModelScope, type ScopedModel } from "./model-resolver.ts";
import type { ConfiguredPlugin } from "./plugin-manager.ts";
import { type PromptTemplate, parseCommandArgs } from "./prompt-templates.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "./resource-loader.ts";
import { createAgentSession } from "./sdk.ts";
import { openAgentSession } from "./session.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type PathMetadata } from "./source-info.ts";
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

export interface SessionHostOptions {
	name: string;
	model: Model<Api>;
	authStorage: AuthStorage;
	/**
	 * Per-agent integration account store. Constructed once (process-scoped) and
	 * must survive `/reload` so per-account state isn't lost.
	 */
	integrationAccounts: IntegrationAccountStorage;
}

/** Options for `SessionHost.prompt()`. */
export interface SessionHostPromptOptions {
	/** Images to attach to the user turn. An `input` transform may also inject these. */
	images?: ImageContent[];
	/** Where the input came from. Default: `"interactive"`. */
	source?: InputSource;
	/** How to deliver the message while a turn is already streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** When false, skip extension-command + skill/template dispatch (extension-driven sends). Default true. */
	expandPromptTemplates?: boolean;
	/**
	 * Fired once the prompt is accepted (handled, queued, or about to run) with `true`, or
	 * with `false` when it is rejected before any work (a mid-stream submit with no
	 * `streamingBehavior`). Lets a headless caller ack acceptance without waiting for the
	 * whole turn — `prompt()` itself only resolves at turn end.
	 */
	preflightResult?: (success: boolean) => void;
}

/**
 * The interactive mode's extension surface, handed to the host once and re-applied to
 * every runner the host builds (per-session swap and `/reload`).
 */
export interface InteractiveContextBindings {
	uiContext: ExtensionUIContext;
	mode: ExtensionMode;
	commandContextActions: ExtensionCommandContextActions;
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

/** A stable `extension:<name>` label for the extension that contributed a resource. */
function getExtensionSourceLabel(extensionPath: string): string {
	if (extensionPath.startsWith("<")) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	const base = basename(extensionPath);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

/**
 * Source metadata for an extension-contributed skill/prompt path (fed to the resource
 * loader via `extendResources`). Attributed to the contributing extension and marked
 * `temporary` (re-derived each load), with the extension's own dir as `baseDir`.
 */
function contributedResourceMetadata(extensionPath: string): PathMetadata {
	const baseDir = extensionPath.startsWith("<") ? undefined : dirname(extensionPath);
	return { source: getExtensionSourceLabel(extensionPath), scope: "temporary", origin: "top-level", baseDir };
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

export class SessionHost {
	private readonly options: SessionHostOptions;
	private _harness?: AgentHarness;
	private _config?: AgentConfig;
	private env?: NodeExecutionEnv;

	// Extension subsystem state. Each is (re)built per session.
	private _extensionRunner?: ExtensionRunner;
	/** Integration producer runner. (Re)built per session; stopped before the new one starts. */
	private _integrationRunner?: IntegrationRunner;
	private _sessionManager?: SessionManager;
	private _modelRegistry?: ModelRegistry;
	/** Session-only model shortlist, resolved against the private registry. Survives harness swaps. */
	private _scopedModels: ScopedModel[] = [];
	/**
	 * Daemon-registered sink that broadcasts a `scoped_models_update` after every scope change.
	 *
	 * TODO: this bespoke host→daemon callback exists only because the broadcaster subscribes to the
	 * harness, which doesn't own scoped models. Either (a) add a general host-level event emitter so
	 * host-originated events flow like harness own-events without a per-feature handler, or (b)
	 * redesign scoped models as a stateless daemon resolver with client-held state (drops this handler
	 * and the `scoped_models_update` event, trading away multi-client scope sync).
	 */
	private _scopedModelsHandler?: (scopedModels: ScopedModel[]) => void;
	/** Teardown fns for the current harness's event wiring (subscribe + on + onMessageEnd). */
	private _unsubscribe: (() => void)[] = [];
	/** The built-in tools, kept so refreshTools() can re-apply base + extension tools. */
	private _baseTools: AgentTool[] = [];
	/** The wrapped extension tools, kept for refreshTools(). */
	private _extensionTools: AgentTool[] = [];
	/** Skills frozen into the prompt this session — surfaced as skill-source commands. */
	private _skills: Skill[] = [];
	/** Prompt templates discovered this session — surfaced as prompt-source commands. */
	private _promptTemplates: PromptTemplate[] = [];
	/** Extensions loaded this session, kept for the resource summary. */
	private _extensionCount = 0;
	/** Extension load failures from the last build, surfaced in the resource summary. */
	private _loadErrors: { path: string; error: string }[] = [];
	/** Integration load + account-store parse failures from the last build, surfaced in the resource summary. */
	private _integrationLoadErrors: { path: string; error: string }[] = [];
	/** Skill name collisions from the last build, surfaced in the resource summary. */
	private _skillDiagnostics: ResourceDiagnostic[] = [];
	/** The frozen system prompt, backing `ctx.getSystemPrompt()`. */
	private _systemPrompt = "";
	/** The options the frozen prompt was built from, backing `ctx.getSystemPromptOptions()`. */
	private _systemPromptOptions?: BuildSystemPromptOptions;
	/** The current run's abort signal, or undefined when idle. */
	private _currentSignal?: AbortSignal;
	/** Queued-message count (steer+followUp+nextTurn), kept in sync via queue_update. */
	private _pendingMessageCount = 0;
	/** Turn counter — the engine's turn_start/turn_end carry no index, so we synthesize one. */
	private _turnIndex = 0;
	/** Graceful-shutdown handler installed by the host mode (default no-op). */
	private _shutdownHandler: () => void = () => {};
	/**
	 * The interactive mode's extension surface, retained so it can be re-applied to every
	 * runner the host builds. Undefined until `bindInteractiveContext()` runs — non-interactive
	 * hosts (print) never call it, so their runners keep the `noOpUIContext`.
	 */
	private _interactiveBindings?: InteractiveContextBindings;
	/** Teardown for the current runner's error listener, dropped before re-binding. */
	private _extensionErrorUnsubscriber?: () => void;
	/** Teardown for the integration runner's error listener, dropped before re-binding. */
	private _integrationErrorUnsubscriber?: () => void;
	/**
	 * Re-subscribe hook fired after every harness swap (`build()`/`newSession()`) and at the
	 * end of `reload()`. A headless wrapper (the daemon) registers it to re-point its event
	 * subscription at the live harness. Default undefined — interactive/print never set it.
	 */
	private _rebindHandler?: (harness: AgentHarness) => void;

	constructor(options: SessionHostOptions) {
		this.options = options;
	}

	/** The live harness. Throws if accessed before `start()`. */
	get harness(): AgentHarness {
		if (!this._harness) throw new Error("SessionHost not started.");
		return this._harness;
	}

	/** The config the live harness was built from (re-read each build). */
	get config(): AgentConfig {
		if (!this._config) throw new Error("SessionHost not started.");
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
		if (!this._extensionRunner) throw new Error("SessionHost not started.");
		return this._extensionRunner;
	}

	/** Install the graceful-shutdown handler exposed to extensions via `ctx.shutdown()`. */
	setShutdownHandler(handler: () => void): void {
		this._shutdownHandler = handler;
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

	/**
	 * Hand the interactive mode's extension surface (UI context, command-context actions,
	 * error listener, shutdown handler) to the host and apply it to the live runner.
	 *
	 * The bindings are retained on the host and re-applied by `_applyInteractiveContext` to
	 * every runner `build()`/`reload()` stands up, so a rebuilt runner never reverts to
	 * `noOpUIContext`. Called once by the interactive mode after it subscribes to the host.
	 */
	bindInteractiveContext(bindings: InteractiveContextBindings): void {
		this._interactiveBindings = bindings;
		if (bindings.shutdownHandler) this.setShutdownHandler(bindings.shutdownHandler);
		this._applyInteractiveContext(this.extensionRunner);
	}

	/**
	 * Apply the retained interactive bindings to `runner`: set its UI context + mode, bind the
	 * command-context actions, and (re)install the error listener. No-op when no interactive
	 * mode has bound yet (the first `build()` runs before `bindInteractiveContext`, leaving the
	 * runner on `noOpUIContext` until the mode binds).
	 */
	private _applyInteractiveContext(runner: ExtensionRunner): void {
		const bindings = this._interactiveBindings;
		if (!bindings) return;
		runner.setUIContext(bindings.uiContext, bindings.mode);
		runner.bindCommandContext(bindings.commandContextActions);
		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = bindings.onError ? runner.onError(bindings.onError) : undefined;

		this._integrationErrorUnsubscriber?.();
		this._integrationErrorUnsubscriber = bindings.onError
			? this._integrationRunner?.onError(bindings.onError)
			: undefined;
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
	 * Live session entries (read-only) — the interactive `/compact` guard counts
	 * messages from these. Exposed on the host because `AgentHarness` keeps its `session`
	 * private, so the interactive mode can't read entries off the harness directly.
	 */
	getEntries(): SessionTreeEntry[] {
		if (!this._sessionManager) throw new Error("SessionHost not started.");
		return this._sessionManager.getEntries();
	}

	/**
	 * Flatten the current branch into a render-ready `SessionContext` (the aligned
	 * messages the interactive mode paints on resume). Reuses the engine's own
	 * `buildSessionContext` over steward's `SessionManager` adapter — `getBranch()`
	 * is exactly the leaf→root `SessionTreeEntry[]` the helper consumes. Exposed on
	 * the host for the same reason as `getEntries`: the harness keeps its `session`
	 * private, so the interactive mode can't reach the engine's `Session.buildContext()`
	 * directly. This synchronous adapter path is used instead.
	 */
	buildSessionContext(): SessionContext {
		if (!this._sessionManager) throw new Error("SessionHost not started.");
		return buildSessionContext(this._sessionManager.getBranch());
	}

	/**
	 * Live slash-command metadata — extension + prompt + skill commands, read-only. The
	 * `getCommands` action wired into `runner.bindCore` is a closure inside `build()`,
	 * unreachable from the interactive mode — which needs the same list to feed editor
	 * autocomplete. Exposed here for the same reason as `getEntries`: the interactive mode
	 * can't read these off the private harness session. Built-in interactive commands
	 * (`BUILTIN_SLASH_COMMANDS`) are layered in by the caller.
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
		const registered = new Map(runner.getAllRegisteredTools().map((rt) => [rt.definition.name, rt]));
		return this.harness.getTools().map((tool) => {
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

	/** Build the first session. */
	async start(options: { fresh?: boolean } = {}): Promise<AgentHarness> {
		return this.build(options.fresh ?? false);
	}

	/**
	 * Tear down the current session and build a fresh one (e.g. after deploy).
	 *
	 * Invariant: while an agent is forming (undeployed) it stays in its single birth
	 * session — only the deploy flow may swap it to a fresh session. The deploy flow
	 * flips `deployedAt` (via `deployAgent`) BEFORE calling this with `reason: "deploy"`,
	 * so the on-disk config re-read below reads as deployed by the time we get here.
	 * A `reason: "new"` swap (the in-process `/new`) against a still-forming config is
	 * refused at this primitive. We key off the caller's explicit intent rather than a
	 * bare `isDeployed` check so correctness does not silently couple to deploy's
	 * flip-then-swap ordering — reordering deploy must not quietly re-open the `/new`
	 * gate. A thrown `newSession()` degrades gracefully (the caller keeps the old harness).
	 */
	async newSession({ reason }: { reason: "deploy" | "new" }): Promise<AgentHarness> {
		if (reason === "new" && !isDeployed(loadAgentConfig(this.options.name))) {
			throw new Error("This agent is still forming — it stays in its birth session until it deploys.");
		}
		return this.build(true);
	}

	/**
	 * Re-discover extensions, skills, and prompt templates in place against the live
	 * session — no new harness, so the conversation is preserved. Re-points the live
	 * harness at the rebuilt resources and tool set.
	 *
	 * The outgoing runner's extension flag values are carried into the new runtime so a
	 * reload does not reset extension state. The system prompt is frozen for the session's
	 * lifetime: the rebuilt prompt backs `ctx.getSystemPrompt()`, but the model-facing
	 * prompt only changes on the next session.
	 */
	async reload(): Promise<void> {
		const harness = this.harness;
		const previousRunner = this.extensionRunner;
		const previousIntegrationRunner = this._integrationRunner;
		const previousFlagValues = previousRunner.getFlagValues();

		// Shut the outgoing runtime down while its ctx is still valid, so extensions can
		// clean up before the new runner takes over.
		await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });

		const config = loadAgentConfig(this.options.name);
		const agentDir = getAgentDir(this.options.name);
		const { runner, integrationRunner, skills, promptTemplates, baseTools, extensionTools } =
			await this.buildResources({
				config,
				agentDir,
				name: this.options.name,
				sessionManager: this._sessionManager!,
				modelRegistry: this._modelRegistry!,
				settingsManager: SettingsManager.create(agentDir, agentDir),
				discoverReason: "reload",
				seedFlagValues: previousFlagValues,
			});
		this._config = config;

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
		// wiring already reads `this.extensionRunner` live, so it re-points at the new
		// runner without re-subscribing.
		this.bindExtensionCore(runner, harness);
		// Stop the previous producer before starting the new one (see build() for why).
		await previousIntegrationRunner?.stop();
		integrationRunner.bindCore();
		await integrationRunner.start();
		this._applyInteractiveContext(runner);

		if (runner.hasHandlers("session_start")) {
			await runner.emit({ type: "session_start", reason: "reload" });
		}

		previousRunner.invalidate();
		// The harness is reused across reload, so re-subscribing is a harmless no-op
		// (unsub-then-sub) — fired for symmetry with build()/newSession().
		this._rebindHandler?.(harness);
	}

	/**
	 * Persist a minimal assistant message into the current session (e.g. the
	 * seeded "What is my purpose?" that opens a forming agent's first chat) and
	 * return it so the caller can also render it. The field shape: api/provider/model
	 * from the configured model, zeroed `usage`, a "stop" stopReason, and a single text
	 * content block.
	 */
	async seedAssistantMessage(text: string): Promise<AssistantMessage> {
		const { model } = this.options;
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
	async prompt(text: string, options?: SessionHostPromptOptions): Promise<void> {
		const runner = this.extensionRunner;
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
			const template = this._promptTemplates.find((t) => t.name === name);
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
			await this._sessionManager!.appendCustomMessageEntry(
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

	/** The live session's id (the JSONL session file's id). */
	getSessionId(): string {
		if (!this._sessionManager) throw new Error("SessionHost not started.");
		return this._sessionManager.getSessionId();
	}

	/** The live session's display name, or undefined when unnamed. */
	getSessionName(): string | undefined {
		if (!this._sessionManager) throw new Error("SessionHost not started.");
		return this._sessionManager.getSessionName();
	}

	/** Path to the live session's JSONL file, or undefined when not yet persisted. */
	getSessionFile(): string | undefined {
		if (!this._sessionManager) throw new Error("SessionHost not started.");
		return this._sessionManager.getSessionFile();
	}

	/**
	 * Resolve a model by `{provider, modelId}` off the encapsulated registry and switch the
	 * live harness to it. Throws on an unknown or unauthenticated model. Keeps the registry
	 * private — the daemon only ever holds the wire `{provider, modelId}` pair.
	 */
	async setModelById(provider: string, modelId: string): Promise<Model<Api>> {
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
		const model = this._modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No configured credentials for ${provider}/${modelId}.`);
		}
		await this.harness.setModel(model);
		// Persist the choice to this agent's own agent.json (`model`), the first source the startup
		// resolution reads (`config.model ?? sharedDefaultModel() ?? DEFAULT_MODEL`), so the agent
		// reopens on it. The shared/global default is a separate concern, set elsewhere.
		const config = loadAgentConfig(this.options.name);
		saveAgentConfig(this.options.name, { ...config, model: `${provider}/${modelId}` });
		return model;
	}

	/**
	 * Switch the live harness's thinking level and persist it as this agent's default in agent.json
	 * (`thinkingLevel`), so a new session reopens on it. Only writes back when the level actually
	 * changes; the `level !== "off"` clause keeps a non-reasoning model from pinning "off" as the
	 * default while still letting an explicit non-off pick persist.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const previous = this.harness.getThinkingLevel();
		await this.harness.setThinkingLevel(level);
		if (level !== previous && (this.harness.getModel().reasoning || level !== "off")) {
			const config = loadAgentConfig(this.options.name);
			saveAgentConfig(this.options.name, { ...config, thinkingLevel: level });
		}
	}

	/** Auth-filtered models off the encapsulated registry — the single-pick selector's candidate list. */
	getAvailableModels(): Model<Api>[] {
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
		return this._modelRegistry.getAvailable();
	}

	/** The session's resolved model shortlist (empty = no scope). */
	getScopedModels(): ScopedModel[] {
		return this._scopedModels;
	}

	/**
	 * Switch the session-only model scope. The patterns are resolved against the private registry
	 * (`[]` clears the scope), then the registered sink broadcasts the resolved list to clients.
	 */
	async setScopedModels(enabledModelIds: string[]): Promise<void> {
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
		this._scopedModels =
			enabledModelIds.length > 0 ? await resolveModelScope(enabledModelIds, this._modelRegistry) : [];
		this._scopedModelsHandler?.(this._scopedModels);
	}

	/** Persist the agent-tier scoped-model shortlist (`enabledModels`) to agent.json. */
	setEnabledModels(enabledModels: string[] | undefined): void {
		const config = loadAgentConfig(this.options.name);
		saveAgentConfig(this.options.name, { ...config, enabledModels });
	}

	/**
	 * Login-eligible providers: every OAuth provider, plus every model provider that authenticates
	 * by API key (built-in providers with a display name, or non-built-in providers without OAuth).
	 * Optionally filtered to a single auth type. Named to match coding-agent's method.
	 */
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
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
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
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
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
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
		if (!this._modelRegistry) throw new Error("SessionHost not started.");
		this.options.authStorage.logout(provider);
		this._modelRegistry.refresh();
	}

	/**
	 * Run a leading-slash extension command if one matches. Returns true when a command
	 * handled the input (so the caller sends nothing to the model).
	 */
	private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.extensionRunner.getCommand(commandName);
		if (!command) return false;

		const ctx = this.extensionRunner.createCommandContext();
		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			this.extensionRunner.emitError({
				path: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	private async build(fresh: boolean): Promise<AgentHarness> {
		const { name, model, authStorage } = this.options;
		const previousEnv = this.env;
		const previousRunner = this._extensionRunner;
		const previousIntegrationRunner = this._integrationRunner;
		const previousUnsubscribe = this._unsubscribe;

		// Re-read: deployedAt may have changed since the previous harness.
		const config = loadAgentConfig(name);
		const { session, env } = await openAgentSession(name, { fresh });
		const agentDir = getAgentDir(name);

		// The seams the extension subsystem is wired against: a SessionManager adapter
		// over the engine's Session, and the model registry (for auth checks + provider
		// registration). The metadata read is what the adapter keys its file snapshot
		// off of.
		const metadata = await session.getMetadata();
		const sessionManager = new SessionManager(session, metadata);
		const modelRegistry = ModelRegistry.create(authStorage);
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		this._sessionManager = sessionManager;
		this._modelRegistry = modelRegistry;

		// Resume restores the session's own model over the agent default: the engine
		// reconstructs `{provider, modelId}` from the branch, and if that model still
		// exists with configured auth it wins. A fresh session keeps the agent model.
		let effectiveModel = model;
		if (!fresh) {
			const sessionModel = this.buildSessionContext().model;
			if (sessionModel) {
				const restored = modelRegistry.find(sessionModel.provider, sessionModel.modelId);
				if (restored && modelRegistry.hasConfiguredAuth(restored)) {
					effectiveModel = restored;
				}
			}
		}

		// Resume restores the session's own thinking level over the agent default: a branch with a
		// thinking_level_change entry pins to its recorded level. A fresh or untouched session follows
		// the agent default (config.thinkingLevel), then DEFAULT_THINKING_LEVEL. Clamped to the model.
		const agentThinking = config.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		const sessionThinking =
			!fresh && this._sessionManager.getBranch().some((e) => e.type === "thinking_level_change")
				? (this.buildSessionContext().thinkingLevel as ThinkingLevel)
				: agentThinking;
		const resolvedThinking = clampThinkingLevel(effectiveModel, sessionThinking) as ThinkingLevel;

		// Discover extensions, load skills/prompts, freeze the prompt, assemble tools.
		// `reload` (fresh) discovers as a new-session reload; resume/first-start as startup.
		const { runner, integrationRunner, skills, promptTemplates, systemPrompt, baseTools, extensionTools } =
			await this.buildResources({
				config,
				agentDir,
				name,
				sessionManager,
				modelRegistry,
				settingsManager,
				discoverReason: fresh ? "reload" : "startup",
			});

		const { harness } = await createAgentSession({
			env,
			session,
			model: effectiveModel,
			systemPrompt,
			thinkingLevel: resolvedThinking,
			tools: [...baseTools, ...extensionTools],
			resources: toHarnessResources(skills, promptTemplates),
			modelRegistry,
			settingsManager,
			sessionId: metadata.id,
		});

		this._config = config;
		this._harness = harness;
		this.env = env;

		// Bind the steward.*/ctx.* action surface to the live harness, re-apply the interactive
		// UI/command-context surface (no-op on the very first build, before the mode binds),
		// then translate the harness's events into extension events. Order: bind before wire
		// so handlers that fire during session_start see a fully-bound context.
		this.bindExtensionCore(runner, harness);
		// Integration producers hold exclusive live connections (e.g. Telegram 409), so the
		// previous runner is stopped BEFORE the new one starts — deliberately the reverse of
		// the extension runner's new-before-old swap below. The credential store is untouched.
		await previousIntegrationRunner?.stop();
		integrationRunner.bindCore();
		await integrationRunner.start();
		this._applyInteractiveContext(runner);
		this._unsubscribe = this.wireExtensionEvents(harness);
		// The harness is brand-new here (its predecessor's subscriptions die with it), so a
		// headless wrapper must re-subscribe to this one.
		this._rebindHandler?.(harness);

		// Announce the session to extensions (guarded — no handlers ⇒ no-op).
		if (runner.hasHandlers("session_start")) {
			await runner.emit({ type: "session_start", reason: fresh ? "new" : "startup" });
		}

		// Release the superseded session: shut its extension runtime down (while its
		// ctx is still valid so extensions can clean up), invalidate it so any captured
		// ctx throws, drop its harness listeners, then release its env.
		if (previousRunner) {
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "new" });
			previousRunner.invalidate();
		}
		for (const unsubscribe of previousUnsubscribe) {
			try {
				unsubscribe();
			} catch {
				/* listener already detached with the discarded harness */
			}
		}
		await previousEnv?.cleanup();
		return harness;
	}

	/**
	 * Discover + load extensions, build the runner, surface discovered skill/prompt
	 * paths into freshly-loaded resources, freeze the system prompt, and assemble the
	 * base + extension tool set. Shared by `build()` (per-session) and `reload()`
	 * (in-place, against the live session). Mutates the resource-half host state
	 * (`_extensionRunner`, `_skills`, `_promptTemplates`, `_systemPrompt(Options)`,
	 * `_baseTools`, `_extensionTools`) and returns the pieces the caller needs to
	 * stand up or re-point the harness.
	 *
	 * `seedFlagValues` carries an outgoing runner's extension flag values into the new
	 * runtime (reload only) — `build()` starts a new session and leaves flags at their
	 * defaults.
	 */
	private async buildResources(params: {
		config: AgentConfig;
		agentDir: string;
		name: string;
		sessionManager: SessionManager;
		modelRegistry: ModelRegistry;
		settingsManager: SettingsManager;
		discoverReason: "startup" | "reload";
		seedFlagValues?: Map<string, boolean | string>;
	}): Promise<{
		runner: ExtensionRunner;
		integrationRunner: IntegrationRunner;
		skills: Skill[];
		promptTemplates: PromptTemplate[];
		systemPrompt: string;
		baseTools: AgentTool[];
		extensionTools: AgentTool[];
		errors: { path: string; error: string }[];
	}> {
		const { config, agentDir, name, sessionManager, modelRegistry, settingsManager, discoverReason, seedFlagValues } =
			params;
		const integrationAccounts = this.options.integrationAccounts;

		// One resource loader owns npm/git/local install + resolution and resolves extensions
		// AND integrations in place from the same per-agent home (cwd = agentDir; there is no
		// project-local resource concept — each agent owns its resources under its home). It
		// builds the *unbound* IntegrationRunner via the hook below (which the loader threads
		// into the extension loader so extensions wire `getIntegration` at load time); this
		// host keeps the runner's stop-before-start lifecycle (see build()/reload()). The
		// integration arm resolves BEFORE the extension arm inside reload(). The account store
		// is process-scoped (survives reload).
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager,
			// The interactive mode owns theme + context-file loading; the host only needs
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

		// This host owns the approval policy (store + gate); the gate reads `getUI` lazily, so
		// `runner` below is in scope by the time it runs mid-tool-call. The default target's env
		// backs the file tools + ctx.environment; `environments` carries the full map to bash.
		const approvals = ApprovalStore.create(name);
		const gate = createApprovalGate(() => runner.getUIContext(), approvals);
		// Daemon-owned control state, write-denied to the agent's own tools on the confined target so it
		// can't self-approve a host escalation or tamper with session history. (agent.json stays writable.)
		const controlState = [getAgentApprovalsPath(name), getSessionsDir(name)];
		const environments = await createEnvironments(agentDir, { gate, denyWrite: controlState });
		const defaultEnv = environments.targets[environments.default];
		const { extensions, errors, runtime } = loader.getExtensions();
		const runner = new ExtensionRunner(extensions, runtime, agentDir, sessionManager, modelRegistry, defaultEnv);
		this._extensionRunner = runner;
		this._extensionCount = extensions.length;
		this._loadErrors = errors;
		// Carry an outgoing runner's flag values into the new runtime before any
		// resources_discover handler can read them (reload only).
		if (seedFlagValues) {
			for (const [flag, value] of seedFlagValues) runner.setFlagValue(flag, value);
		}
		// Surface load errors through the runner's error channel (no listeners yet at
		// build time → silent: the host mode attaches a listener later).
		for (const { path, error } of errors) {
			runner.emitError({ path, event: "load", error });
		}

		// Let extensions contribute additional skill/prompt paths before the prompt is
		// frozen, then re-resolve skills/prompts through the loader so the contributed paths
		// merge with the auto-discovered + package-resolved ones. Fires after the runner exists.
		const discovered = await runner.emitResourcesDiscover(agentDir, discoverReason);
		loader.extendResources({
			skillPaths: discovered.skillPaths.map((s) => ({
				path: s.path,
				metadata: contributedResourceMetadata(s.extensionPath),
			})),
			promptPaths: discovered.promptPaths.map((p) => ({
				path: p.path,
				metadata: contributedResourceMetadata(p.extensionPath),
			})),
		});

		// Read curated files ONCE and freeze them into the prompt. Mid-session edits
		// (memory tool / file tools) persist to disk but only enter the prompt next session.
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
		this._systemPrompt = systemPrompt;
		this._systemPromptOptions = systemPromptOptions;

		return { runner, integrationRunner, skills, promptTemplates, systemPrompt, baseTools, extensionTools, errors };
	}

	/**
	 * Derive context-window usage for the active model from the engine's branch entries +
	 * the `@opsyhq/agent` compaction helpers. Returns `{tokens:null,...}` right after a
	 * compaction (before the next assistant response re-establishes a usage figure).
	 */
	private computeContextUsage(harness: AgentHarness, sessionManager: SessionManager): ContextUsage | undefined {
		const model = harness.getModel();
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const branchEntries = sessionManager.getBranch();
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
	 * Bind the `steward.*` actions + `ctx.*` context actions to the live harness via
	 * `runner.bindCore()`. Providers are flushed through the constructed modelRegistry
	 * (2-arg bindCore, no providerActions), so queued `steward.registerProvider(...)` calls
	 * apply immediately. `harness`/`sessionManager`/`modelRegistry` are captured locally
	 * so each binding stays tied to its own session even after a `newSession()` swap.
	 */
	private bindExtensionCore(runner: ExtensionRunner, harness: AgentHarness): void {
		const sessionManager = this._sessionManager!;
		const modelRegistry = this._modelRegistry!;
		const cwd = getAgentDir(this.options.name);

		const actions: ExtensionActions = {
			// Delegate to the async delivery path and route rejections to the extension error
			// channel — a mistimed send surfaces as an extension error, not an unhandled
			// rejection that crashes the process. `runner` is the captured local (not
			// `this.extensionRunner`) so a delivery that rejects after a reload reports to the
			// runner it was bound to.
			sendMessage: (message, options) => {
				this.sendCustomMessage(message, options).catch((err) =>
					runner.emitError({
						path: "<runtime>",
						event: "send_message",
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
			sendUserMessage: (content, options) => {
				this.sendUserMessage(content, options).catch((err) =>
					runner.emitError({
						path: "<runtime>",
						event: "send_user_message",
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
			appendEntry: (customType, data) => {
				void sessionManager.appendCustomEntry(customType, data);
			},
			setSessionName: (sessionName) => {
				void sessionManager.appendSessionInfo(sessionName);
			},
			getSessionName: () => sessionManager.getSessionName(),
			setLabel: (entryId, label) => {
				void sessionManager.appendLabelChange(entryId, label);
			},
			getActiveTools: () => harness.getActiveTools().map((tool) => tool.name),
			getAllTools: (): ToolInfo[] => {
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
					// Built-in tools have no RegisteredTool/SourceInfo — synthesize one.
					return {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						promptGuidelines: undefined,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${tool.name}>`, { source: "builtin" }),
					};
				});
			},
			setActiveTools: (toolNames) => {
				void harness.setActiveTools(toolNames);
			},
			refreshTools: () => {
				const active = harness.getActiveTools().map((tool) => tool.name);
				void harness.setTools([...this._baseTools, ...this._extensionTools], active);
			},
			getCommands: (): SlashCommandInfo[] => {
				const commands: SlashCommandInfo[] = [];
				for (const command of runner.getRegisteredCommands()) {
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
					// Skills are invoked as `/skill:<name>`; kept identical to SessionHost.getCommands().
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}
				return commands;
			},
			setModel: async (nextModel) => {
				if (!modelRegistry.hasConfiguredAuth(nextModel)) return false;
				await harness.setModel(nextModel);
				return true;
			},
			getThinkingLevel: () => harness.getThinkingLevel(),
			setThinkingLevel: (level) => {
				void this.setThinkingLevel(level);
			},
		};

		const contextActions: ExtensionContextActions = {
			getModel: () => harness.getModel(),
			isIdle: () => harness.isIdle,
			// Flagged divergence: steward has no project-trust concept (no settings store
			// of trusted projects); the agent home is always trusted.
			isProjectTrusted: () => true,
			getSignal: () => this._currentSignal,
			abort: () => {
				void harness.abort();
			},
			hasPendingMessages: () => this._pendingMessageCount > 0,
			shutdown: () => this._shutdownHandler(),
			getContextUsage: () => this.computeContextUsage(harness, sessionManager),
			compact: (options) => {
				void harness
					.compact(options?.customInstructions)
					.then((result) => options?.onComplete?.(result))
					.catch((error) => options?.onError?.(error instanceof Error ? error : new Error(String(error))));
			},
			getSystemPrompt: () => this._systemPrompt,
			getSystemPromptOptions: () => this._systemPromptOptions ?? { cwd },
		};

		// 2-arg bindCore: no providerActions, so queued provider registrations flush
		// directly through the modelRegistry the runner was constructed with.
		runner.bindCore(actions, contextActions);
	}

	/**
	 * Translate the harness's events into extension `ExtensionEvent`s and return the
	 * teardown fns. See the three-way split documented at the top of the file.
	 *
	 * Every handler reads `this.extensionRunner` (the live getter) rather than capturing a
	 * `runner` argument: the harness outlives a reload but `_extensionRunner` is swapped in
	 * `buildResources`, so reading the field at event time re-points wiring at the fresh
	 * runner without re-subscribing.
	 */
	private wireExtensionEvents(harness: AgentHarness): (() => void)[] {
		const cwd = getAgentDir(this.options.name);
		const unsubscribe: (() => void)[] = [];

		// (b) subscribe() — receives ALL events (AgentEvent + harness own-events). It
		// keeps host streaming/turn/queue state in sync and emits the lifecycle
		// ExtensionEvents. message_end is intentionally skipped (see (c)).
		unsubscribe.push(
			harness.subscribe(async (event, signal) => {
				const runner = this.extensionRunner;
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
				const runner = this.extensionRunner;
				if (!runner.hasHandlers("tool_call")) return undefined;
				return runner.emitToolCall(event as unknown as ToolCallEvent);
			}),
		);
		unsubscribe.push(
			harness.on("tool_result", async (event) => {
				const runner = this.extensionRunner;
				if (!runner.hasHandlers("tool_result")) return undefined;
				return runner.emitToolResult(event as unknown as ToolResultEvent);
			}),
		);
		unsubscribe.push(
			harness.on("context", async (event) => {
				const runner = this.extensionRunner;
				if (!runner.hasHandlers("context")) return undefined;
				const messages = await runner.emitContext(event.messages);
				return { messages };
			}),
		);
		unsubscribe.push(
			harness.on("before_provider_payload", async (event) => {
				const runner = this.extensionRunner;
				// Maps to the extension `before_provider_request` event.
				if (!runner.hasHandlers("before_provider_request")) return undefined;
				const payload = await runner.emitBeforeProviderRequest(event.payload);
				return { payload };
			}),
		);
		unsubscribe.push(
			harness.on("before_agent_start", async (event) => {
				const runner = this.extensionRunner;
				if (!runner.hasHandlers("before_agent_start")) return undefined;
				const result = await runner.emitBeforeAgentStart(
					event.prompt,
					event.images,
					event.systemPrompt,
					this._systemPromptOptions ?? { cwd },
				);
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
				const runner = this.extensionRunner;
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
				const runner = this.extensionRunner;
				if (!runner.hasHandlers("message_end")) return;
				const replacement = await runner.emitMessageEnd({ type: "message_end", message });
				if (replacement && replacement !== message) {
					replaceMessageInPlace(message, replacement);
				}
			}),
		);

		return unsubscribe;
	}

	/** Release the live session's env. Best-effort. */
	async cleanup(): Promise<void> {
		// Stop live integration producers at process exit — they hold real connections.
		await this._integrationRunner?.stop();
		await this.env?.cleanup();
		this.env = undefined;
		// Tear down the process-global srt singleton (proxy servers + OS profile) and stop this
		// agent's docker sandbox container. Both are no-ops when their backend never ran.
		await resetSandbox();
		await stopContainer(getAgentDir(this.options.name));
	}
}
