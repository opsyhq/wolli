/**
 * Session host — owns building and swapping an agent's session/harness.
 *
 * Steward's minimal analogue of `@opsyhq/coding-agent`'s `AgentSessionRuntime`
 * (the "runtimeHost"). It is the single home for the session lifecycle: it
 * resolves the env, freezes the system prompt, wires the tools, and on
 * `newSession()` tears the current env down and builds a fresh harness. The
 * interactive mode holds a `SessionHost` and calls `newSession()` to swap in
 * place — required because the system prompt is frozen for a session's lifetime,
 * so a transition that must change the prompt (the birth instruction dropping at
 * deploy) needs a new harness.
 *
 * `build()` is also the landing site for the extension subsystem: it discovers +
 * loads extensions, builds the `ExtensionRunner`, surfaces discovered skills into
 * the frozen prompt, registers extension tools alongside the built-ins, binds the
 * `pi.*`/`ctx.*` action surface to the live harness, and translates the harness's
 * events into extension `ExtensionEvent`s.
 *
 * Substrate-forced divergence (flagged throughout): pi's `AgentSession` calls the
 * runner's emit methods inline from its own loop. Steward's `AgentHarness` instead
 * exposes a dual event mechanism, so the emission is split three ways:
 *  (a) `harness.on(type)` native mutating hooks — tool_call, tool_result, context,
 *      before_agent_start, before_provider_payload, session_before_compact;
 *  (b) `harness.subscribe()` — a translator from `AgentEvent`/own-events to the
 *      lifecycle `ExtensionEvent`s (agent/turn/message/tool-exec, model/thinking);
 *  (c) `harness.onMessageEnd()` — the message_end interceptor (the engine discards
 *      return values from subscribe/on for message_end and persists on the
 *      interceptor path, so a mutating message_end must ride that seam).
 */

import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentHarness,
	type AgentMessage,
	type AgentTool,
	calculateContextTokens,
	estimateContextTokens,
	type SessionTreeEntry,
	type ThinkingLevel,
} from "@opsyhq/agent";
import type { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getAgentDir } from "../config.ts";
import { type AgentConfig, isDeployed, loadAgentConfig } from "./agent-config.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { discoverAndLoadExtensions } from "./extensions/loader.ts";
import { emitSessionShutdownEvent, ExtensionRunner } from "./extensions/runner.ts";
import type {
	ContextUsage,
	ExtensionActions,
	ExtensionContextActions,
	ToolCallEvent,
	ToolInfo,
	ToolResultEvent,
} from "./extensions/types.ts";
import { loadMemory } from "./memory.ts";
import { createCustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { loadPromptTemplates, type PromptTemplate } from "./prompt-templates.ts";
import { createAgentSession } from "./sdk.ts";
import { openAgentSession } from "./session.ts";
import { SessionManager } from "./session-manager.ts";
import { loadSkills, type Skill } from "./skills.ts";
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

export interface SessionHostOptions {
	name: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	authStorage: AuthStorage;
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
 * Scan a branch (root→leaf) from the end for the most recent compaction entry.
 *
 * Substrate-forced: pi exposed `getLatestCompactionEntry` off its SessionManager;
 * steward's adapter doesn't, so it is authored inline against the engine's branch
 * entries (the engine persists compaction as a `compaction`-typed tree entry).
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

export class SessionHost {
	private readonly options: SessionHostOptions;
	private _harness?: AgentHarness;
	private _config?: AgentConfig;
	private env?: NodeExecutionEnv;

	// Extension subsystem state (Tier 5 wiring). Each is (re)built per session.
	private _extensionRunner?: ExtensionRunner;
	private _sessionManager?: SessionManager;
	private _modelRegistry?: ModelRegistry;
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
	/** The frozen system prompt (mirrors `ctx.getSystemPrompt()`). */
	private _systemPrompt = "";
	/** The options the frozen prompt was built from (mirrors `ctx.getSystemPromptOptions()`). */
	private _systemPromptOptions?: BuildSystemPromptOptions;
	/** Live streaming flag, kept in sync by the subscribe() translator. */
	private _isStreaming = false;
	/** The current run's abort signal, or undefined when idle. */
	private _currentSignal?: AbortSignal;
	/** Queued-message count (steer+followUp+nextTurn), kept in sync via queue_update. */
	private _pendingMessageCount = 0;
	/** Turn counter — the engine's turn_start/turn_end carry no index, so we synthesize one. */
	private _turnIndex = 0;
	/** Graceful-shutdown handler installed by the host mode (default no-op). */
	private _shutdownHandler: () => void = () => {};

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
	 * The dir tools operate in — the agent's home dir, where SOUL/MEMORY/USER.md
	 * and workspace/ live. Mirrors `@opsyhq/coding-agent`'s `SessionManager.getCwd()`,
	 * which the interactive mode passes into each `ToolExecutionComponent` so its
	 * built-in renderers can reconstruct from cwd.
	 */
	getCwd(): string {
		return getAgentDir(this.options.name);
	}

	/** Build the first session. */
	async start(options: { fresh?: boolean } = {}): Promise<AgentHarness> {
		return this.build(options.fresh ?? false);
	}

	/** Tear down the current session and build a fresh one (e.g. after deploy). */
	async newSession(): Promise<AgentHarness> {
		return this.build(true);
	}

	/**
	 * Persist a minimal assistant message into the current session (e.g. the
	 * seeded "What is my purpose?" that opens a forming agent's first chat) and
	 * return it so the caller can also render it. The field shape is copied from
	 * `createFailureMessage` (agent-harness.ts:49): api/provider/model from the
	 * configured model, zeroed `usage`, a "stop" stopReason, and a single text
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

	private async build(fresh: boolean): Promise<AgentHarness> {
		const { name, model, thinkingLevel, authStorage } = this.options;
		const previousEnv = this.env;
		const previousRunner = this._extensionRunner;
		const previousUnsubscribe = this._unsubscribe;

		// Re-read: deployedAt may have changed since the previous harness.
		const config = loadAgentConfig(name);
		const { session, env } = await openAgentSession(name, { fresh });
		const agentDir = getAgentDir(name);

		// Substrate seams the extension subsystem is wired against: a SessionManager
		// adapter over the engine's Session, and the model registry (for auth checks +
		// provider registration). The metadata read is what the adapter keys its file
		// snapshot off of.
		const metadata = await session.getMetadata();
		const sessionManager = new SessionManager(session, metadata);
		const modelRegistry = ModelRegistry.create(authStorage);

		// Discover + load extensions, then build the runner. Substrate-forced divergence:
		// steward scopes extensions per-agent — both project-local (`<agentDir>/.steward/
		// extensions/`) and "global" (`<agentDir>/extensions/`) resolve under the agent's
		// own home, because steward's shared dir is pi's credential store, not an extension
		// home. So cwd and agentDir are both the per-agent dir here.
		const { extensions, errors, runtime } = await discoverAndLoadExtensions([], agentDir, agentDir);
		const runner = new ExtensionRunner(extensions, runtime, agentDir, sessionManager, modelRegistry);
		this._extensionRunner = runner;
		this._sessionManager = sessionManager;
		this._modelRegistry = modelRegistry;
		// Surface load errors through the runner's error channel (no listeners yet at
		// build time → silent, matching pi: the host mode attaches a listener later).
		for (const { path, error } of errors) {
			runner.emitError({ extensionPath: path, event: "load", error });
		}

		// Let extensions contribute additional skill/prompt/theme paths before the
		// prompt is frozen. Fires after the runner exists (mirrors pi's post-load step).
		const discovered = await runner.emitResourcesDiscover(agentDir, fresh ? "reload" : "startup");

		// Read curated files ONCE and freeze them into the prompt. Mid-session edits
		// (memory tool / file tools) persist to disk but only enter the prompt next session.
		const { soul, memory, user } = loadMemory(name);
		const { skills } = loadSkills({
			cwd: agentDir,
			agentDir,
			skillPaths: discovered.skillPaths.map((s) => s.path),
			includeDefaults: true,
		});
		const promptTemplates = loadPromptTemplates({
			cwd: agentDir,
			agentDir,
			promptPaths: discovered.promptPaths.map((p) => p.path),
			includeDefaults: true,
		});
		this._skills = skills;
		this._promptTemplates = promptTemplates;

		// Skills are appended to the frozen prompt (mirrors pi). The structured options
		// are retained so extensions can read them via ctx.getSystemPromptOptions().
		const systemPromptOptions: BuildSystemPromptOptions = { config, cwd: agentDir, soul, memory, user, skills };
		const systemPrompt = buildSystemPrompt(systemPromptOptions);
		this._systemPrompt = systemPrompt;
		this._systemPromptOptions = systemPromptOptions;

		// Tools operate in the agent's home dir, where SOUL/MEMORY/USER.md and the
		// workspace/ subdir live. memory is steward's curated-notes tool; the rest
		// are pi's read/write/edit/ls/grep/find plus bash, wired exactly as pi wires
		// them — bash uses pi's default local shell operations (it streams output
		// itself via the renderer's onUpdate), so there are no overrides.
		const baseTools: AgentTool[] = [
			createMemoryTool(name),
			// The deploy tool only exists while forming — the agent uses it to author
			// its purpose + SOUL.md and ask to be deployed. Once deployed it has served
			// its purpose and is omitted.
			...(isDeployed(config) ? [] : [createDeployTool(name)]),
			createReadTool(agentDir),
			createWriteTool(agentDir),
			createEditTool(agentDir),
			createLsTool(agentDir),
			createGrepTool(agentDir),
			createFindTool(agentDir),
			createBashTool(agentDir),
		];
		// Wrap each extension-registered tool into an engine AgentTool. The context
		// factory is lazy (`runner.createContext()`) so it resolves the live binding
		// at execution time — tools only execute mid-turn, after bindCore() has run.
		const extensionTools: AgentTool[] = runner
			.getAllRegisteredTools()
			.map((rt) => wrapToolDefinition(rt.definition, () => runner.createContext()));
		this._baseTools = baseTools;
		this._extensionTools = extensionTools;

		const { harness } = await createAgentSession({
			env,
			session,
			model,
			systemPrompt,
			thinkingLevel,
			tools: [...baseTools, ...extensionTools],
			authStorage,
		});

		this._config = config;
		this._harness = harness;
		this.env = env;

		// Bind the pi.*/ctx.* action surface to the live harness, then translate the
		// harness's events into extension events. Order: bind before wire so handlers
		// that fire during session_start see a fully-bound context.
		this.bindExtensionCore(runner, harness);
		this._unsubscribe = this.wireExtensionEvents(runner, harness);

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
	 * Derive context-window usage for the active model. Substrate-forced: pi read this
	 * off its SessionManager; steward derives it from the engine's branch entries + the
	 * `@opsyhq/agent` compaction helpers. Returns `{tokens:null,...}` right after a
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
	 * Bind the `pi.*` actions + `ctx.*` context actions to the live harness via
	 * `runner.bindCore()`. Providers are flushed through the constructed modelRegistry
	 * (2-arg bindCore, no providerActions), so queued `pi.registerProvider(...)` calls
	 * apply immediately. `harness`/`sessionManager`/`modelRegistry` are captured locally
	 * so each binding stays tied to its own session even after a `newSession()` swap.
	 */
	private bindExtensionCore(runner: ExtensionRunner, harness: AgentHarness): void {
		const sessionManager = this._sessionManager!;
		const modelRegistry = this._modelRegistry!;
		const cwd = getAgentDir(this.options.name);

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				if (!options?.triggerTurn) {
					// Persist a custom_message entry. The engine's buildSessionContext
					// surfaces custom_message entries into the next turn's context (as a
					// user message) AND the entry is renderable via a registered message
					// renderer — so this single append both delivers and displays.
					void sessionManager.appendCustomMessageEntry(
						message.customType,
						message.content,
						message.display,
						message.details,
					);
					return;
				}
				// triggerTurn (flagged substrate adapter): under steward's substrate a
				// persisted custom_message auto-surfaces into context, so pi's persist+
				// prompt path would double-inject. Instead we drive the turn with the
				// message's own content exactly once (delivered as a user-role turn — the
				// customType/details/renderer are not applied on this triggering path).
				const text = contentToText(message.content);
				const images = contentToImages(message.content);
				if (this._isStreaming) {
					const deliverAs = options.deliverAs ?? "followUp";
					if (deliverAs === "steer") void harness.steer(text, { images });
					else if (deliverAs === "nextTurn") void harness.nextTurn(text, { images });
					else void harness.followUp(text, { images });
				} else {
					void harness.prompt(text, { images });
				}
			},
			sendUserMessage: (content, options) => {
				// Always triggers a turn. Deliver via the requested queue while streaming,
				// otherwise start a fresh turn.
				const text = contentToText(content);
				const images = contentToImages(content);
				if (this._isStreaming) {
					if ((options?.deliverAs ?? "followUp") === "steer") void harness.steer(text, { images });
					else void harness.followUp(text, { images });
				} else {
					void harness.prompt(text, { images });
				}
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
					commands.push({
						name: skill.name,
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
				void harness.setThinkingLevel(level);
			},
		};

		const contextActions: ExtensionContextActions = {
			getModel: () => harness.getModel(),
			isIdle: () => !this._isStreaming,
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
	 */
	private wireExtensionEvents(runner: ExtensionRunner, harness: AgentHarness): (() => void)[] {
		const cwd = getAgentDir(this.options.name);
		const unsubscribe: (() => void)[] = [];

		// (b) subscribe() — receives ALL events (AgentEvent + harness own-events). It
		// keeps host streaming/turn/queue state in sync and emits the lifecycle
		// ExtensionEvents. message_end is intentionally skipped (see (c)).
		unsubscribe.push(
			harness.subscribe(async (event, signal) => {
				switch (event.type) {
					case "agent_start": {
						this._isStreaming = true;
						// The run's abort signal rides every dispatch — capture it for ctx.signal.
						this._currentSignal = signal;
						this._turnIndex = 0;
						if (runner.hasHandlers("agent_start")) await runner.emit({ type: "agent_start" });
						return;
					}
					case "agent_end": {
						this._isStreaming = false;
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
				if (!runner.hasHandlers("tool_call")) return undefined;
				return runner.emitToolCall(event as unknown as ToolCallEvent);
			}),
		);
		unsubscribe.push(
			harness.on("tool_result", async (event) => {
				if (!runner.hasHandlers("tool_result")) return undefined;
				return runner.emitToolResult(event as unknown as ToolResultEvent);
			}),
		);
		unsubscribe.push(
			harness.on("context", async (event) => {
				if (!runner.hasHandlers("context")) return undefined;
				const messages = await runner.emitContext(event.messages);
				return { messages };
			}),
		);
		unsubscribe.push(
			harness.on("before_provider_payload", async (event) => {
				// Maps to the extension `before_provider_request` event.
				if (!runner.hasHandlers("before_provider_request")) return undefined;
				const payload = await runner.emitBeforeProviderRequest(event.payload);
				return { payload };
			}),
		);
		unsubscribe.push(
			harness.on("before_agent_start", async (event) => {
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
		await this.env?.cleanup();
		this.env = undefined;
	}
}
