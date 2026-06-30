/**
 * The `@opsyhq/wolli` client surface:
 *   - `Wolli`       — the agent collection (`list`/`get`/`create`).
 *   - `Agent`         — one agent: registry data + lifecycle + the `fetch`/SSE transport to its daemon
 *                       (the root control stream, the `send` site, the session map).
 *   - `SessionHandle` — the per-session proxy the TUI and `--print` drive, over `/sessions/:id/*`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage, SessionContext, SessionTreeEntry, ThinkingLevel } from "@opsyhq/agent";
import { getDaemonHost, getDaemonToken, getHomeDir } from "./config.ts";
import type { ContextInfo, IntegrationInfo } from "./core/agent-runtime.ts";
import { type AgentConfig, AgentSettingsManager } from "./core/agent-settings-manager.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { THINKING_LEVELS } from "./core/defaults.ts";
import type { ResourceSummary } from "./core/diagnostics.ts";
import type {
	ExtensionContext,
	ExtensionShortcut,
	MessageRenderer,
	SlashCommandInfo,
	ToolInfo,
	UserBashEvent,
	UserBashEventResult,
} from "./core/extensions/index.ts";
import type { KeyId } from "./core/keybindings.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import type { ScopedModel } from "./core/model-resolver.ts";
import type { ConfiguredPlugin } from "./core/plugin-manager.ts";
import { daemonLaunchCommand, getServiceManager } from "./core/service/service-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import type { Skill } from "./core/skills.ts";
import type {
	AuthSelectorProvider,
	DaemonAgentState,
	DaemonCommand,
	DaemonControlEvent,
	DaemonResponse,
	DaemonSessionInfo,
	DaemonSessionState,
	DaemonSessionSummary,
	ExtensionUIRequest,
	LoginUIRequest,
	OnboardServiceResult,
	ScopedModelsUpdateEvent,
} from "./types.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type SessionEvent = AgentHarnessEvent | ScopedModelsUpdateEvent;

/**
 * One SSE connection. `open()` fetches `GET <url>`, resolves with the first `hello` frame's raw data,
 * then streams every later frame to `onFrame` in the background until `close()`. The framing (split on
 * `\n\n`, join multi-line `data:`, skip keepalive comments + malformed frames) and the abort live here,
 * so the control stream and each session stream are each just an `SseStream` — no free helper.
 */
class SseStream {
	private readonly abort = new AbortController();
	private readonly url: string;
	private readonly token: string;

	constructor(url: string, token: string) {
		this.url = url;
		this.token = token;
	}

	/** Open the stream; resolve with the `hello` frame's raw data. Every later frame goes to `onFrame`. */
	async open(onFrame: (data: string) => void): Promise<string> {
		const response = await fetch(this.url, {
			headers: { authorization: `Bearer ${this.token}` },
			signal: this.abort.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Failed to open SSE stream ${this.url} (HTTP ${response.status}).`);
		}
		const hello = deferred<string>();
		void this.consume(response.body, (event, data) => {
			if (event === "hello") hello.resolve(data);
			else onFrame(data);
		});
		return hello.promise;
	}

	close(): void {
		this.abort.abort();
	}

	/** Frame the SSE body and hand each `event`/`data` pair to `onFrame`; a single bad frame is skipped. */
	private async consume(
		body: ReadableStream<Uint8Array>,
		onFrame: (event: string, data: string) => void,
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of body) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf("\n\n");
					let event = "message";
					let data = "";
					for (const line of raw.split("\n")) {
						if (line.startsWith(":")) continue; // keepalive comment
						if (line.startsWith("event:")) event = line.slice(6).trim();
						else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
					}
					if (!data) continue;
					try {
						onFrame(event, data);
					} catch {
						// A single bad frame must not kill the stream.
					}
				}
			}
		} catch {
			// The stream ended or was aborted.
		}
	}
}

/** Top level: the agent collection on disk, plus the lazily-built global auth + settings + model registry. */
export class Wolli {
	private _auth?: AuthStorage;
	private _settings?: SettingsManager;
	private _registry?: ModelRegistry;

	/** Every agent under the agents root, as handles. */
	list(): Agent[] {
		return AgentSettingsManager.list().map((store) => new Agent(store.config));
	}

	/** True once the user has set anything up (the wolli home exists); else a pristine machine → onboarding. */
	isOnboarded(): boolean {
		return existsSync(getHomeDir());
	}

	/** A handle for `name` if it exists on disk, else `undefined`. */
	get(name: string): Agent | undefined {
		const store = AgentSettingsManager.get(name);
		return store ? new Agent(store.config) : undefined;
	}

	/** Create the agent's home tree and return its handle. */
	create(name: string, opts: { purpose?: string; model?: string } = {}): Agent {
		return new Agent(AgentSettingsManager.createAgent({ name, ...opts }).config);
	}

	/**
	 * The global credential tier (`~/.wolli/agent/auth.json`), built once. The dashboard + onboarding
	 * views read + write through it; the per-agent daemon writes its own (agent-tier) credentials.
	 */
	get auth(): AuthStorage {
		this._auth ??= AuthStorage.create();
		return this._auth;
	}

	/** The global settings tier (`~/.wolli/agent/settings.json`), built once — parallels `get auth()`. */
	get settings(): SettingsManager {
		this._settings ??= SettingsManager.create();
		return this._settings;
	}

	/** A model registry over the global tier, built once — the views' source of available models. */
	get registry(): ModelRegistry {
		this._registry ??= ModelRegistry.create(this.auth);
		return this._registry;
	}
}

/** The agent's control-stream lifecycle callbacks — the session list changing under it. */
export interface AgentControlEvents {
	sessionAdded: (session: DaemonSessionSummary) => void;
	sessionRemoved: (sessionId: string) => void;
	sessionRenamed: (sessionId: string, sessionName: string | undefined) => void;
}

/**
 * One agent: registry data, per-agent lifecycle, and the `fetch`/SSE transport to its per-agent daemon
 * — the single `fetch` site (`send`), the root control stream (agent snapshot + session lifecycle), and
 * the `SessionHandle` map. Per-session work rides a `SessionHandle` from `getSession(id)`; agent-level
 * session ops (`createSession`/`deploy`) live here, since they spawn a new session and may swap transport.
 */
export class Agent {
	readonly config: AgentConfig;
	/** The resident `SessionHandle`s, keyed by session id. */
	readonly sessions = new Map<string, SessionHandle>();

	// Not readonly: a deploy handoff re-points the transport at the supervised daemon.
	private base?: string;
	private token?: string;
	private agentState?: DaemonAgentState;
	private controlStream?: SseStream;
	private readonly controlListeners: { [K in keyof AgentControlEvents]: Set<AgentControlEvents[K]> } = {
		sessionAdded: new Set(),
		sessionRemoved: new Set(),
		sessionRenamed: new Set(),
	};

	constructor(config: AgentConfig) {
		this.config = config;
	}

	get name(): string {
		return this.config.name;
	}

	/**
	 * Find the agent's live daemon (config → /health) and connect, else spawn a detached `daemon <name>`
	 * (the same command the OS service unit runs) and wait for it. Ensures the control link; opens no
	 * session (use `getSession(id)` / `getLatestSession()`).
	 */
	async connect(): Promise<void> {
		const { port, token: persisted } = AgentSettingsManager.create(this.name).config;
		const base = `http://${getDaemonHost()}:${port}`;
		const token = getDaemonToken() || persisted;
		if (!(await isHealthy(base))) {
			// The launch command goes through the running binary, since `wolli` isn't on PATH in dev.
			const [command, ...commandArgs] = daemonLaunchCommand(this.name);
			spawn(command, commandArgs, { detached: true, stdio: "ignore" }).unref();
			await waitForHealth(base);
		}
		this.base = base;
		this.token = token;
		await this.openControlStream(this.base, this.token);
	}

	/** The agent-global snapshot (config, cwd, session list) from the control stream's hello. */
	getAgentState(): DaemonAgentState {
		if (!this.agentState) throw new Error("Agent not connected. Call connect() first.");
		return this.agentState;
	}

	/** Subscribe to a control-stream lifecycle event (session added/removed/renamed). Returns an unsubscribe. */
	on<K extends keyof AgentControlEvents>(event: K, listener: AgentControlEvents[K]): () => void {
		this.controlListeners[event].add(listener);
		return () => this.controlListeners[event].delete(listener);
	}

	/** The stored sessions (resident + idle), newest first — round-trips `GET /sessions`. */
	async listSessions(): Promise<DaemonSessionSummary[]> {
		const response = await fetch(`${this.base}/sessions`, {
			headers: { authorization: `Bearer ${this.token}` },
		});
		const body = (await response.json()) as DaemonAgentState;
		this.agentState = body;
		return body.sessions;
	}

	/** The stored sessions with the rich fields the resume selector renders — round-trips `GET /sessions/detail`. */
	async listSessionsDetail(): Promise<DaemonSessionInfo[]> {
		const response = await fetch(`${this.base}/sessions/detail`, {
			headers: { authorization: `Bearer ${this.token}` },
		});
		return (await response.json()) as DaemonSessionInfo[];
	}

	/** Open (or return the cached) `SessionHandle` for a session id, opening its event stream. */
	async getSession(id: string): Promise<SessionHandle> {
		const existing = this.sessions.get(id);
		if (existing) return existing;
		if (!this.base || !this.token) throw new Error("Agent not connected. Call connect() first.");
		const stream = new SseStream(`${this.base}/sessions/${id}/events`, this.token);
		const handle = await SessionHandle.open(this, id, stream);
		this.sessions.set(id, handle);
		return handle;
	}

	/** Open the agent's most-recent session — the daemon guarantees at least one exists. */
	async getLatestSession(): Promise<SessionHandle> {
		const [latest] = await this.listSessions();
		if (!latest) throw new Error(`No session for agent "${this.name}".`);
		return this.getSession(latest.sessionId);
	}

	/** POST a command to a session's `/control` and unwrap the response. */
	async send<T>(sessionId: string, cmd: DaemonCommand): Promise<T> {
		const response = await fetch(`${this.base}/sessions/${sessionId}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify(cmd),
		});
		const body = (await response.json()) as DaemonResponse;
		if (!body.success) throw new Error(body.error);
		return body.data as T;
	}

	/** Answer a parked daemon-side dialog for a session (fire-and-forget). */
	async respondUi(sessionId: string, id: string, answer: Record<string, unknown>): Promise<void> {
		await fetch(`${this.base}/sessions/${sessionId}/ui-response`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ type: "extension_ui_response", id, ...answer }),
		});
	}

	/** Answer a parked daemon-side login dialog for a session (fire-and-forget). */
	async respondLogin(sessionId: string, id: string, answer: Record<string, unknown>): Promise<void> {
		await fetch(`${this.base}/sessions/${sessionId}/login-response`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ type: "login_ui_response", id, ...answer }),
		});
	}

	/**
	 * Create a fresh session (additive) and return its snapshot — the caller opens + switches to it.
	 * `create_session` acts agent-globally but the wire posts it to a session's `/control`, so route it
	 * through the snapshot's most-recent session (the daemon rehydrates an idle target).
	 */
	createSession(): Promise<DaemonSessionState> {
		const [latest] = this.getAgentState().sessions;
		if (!latest) throw new Error(`No session for agent "${this.name}".`);
		return this.send<DaemonSessionState>(latest.sessionId, { type: "create_session" });
	}

	/**
	 * Commit the deploy. The daemon flips the latch, enables the OS unit, and creates a fresh deployed
	 * session (returned). With a real backend the client then drives a stop-then-start handoff on the fixed
	 * port: shut the birth daemon down, start the unit's daemon (same port, resumes the session), reconnect.
	 * Brief socket gap, no state loss (session on disk). The `none` backend has no supervisor, so the birth
	 * daemon stays put.
	 */
	async deploy(): Promise<DaemonSessionState> {
		const { port, token: persisted } = AgentSettingsManager.create(this.name).config;
		const base = `http://${getDaemonHost()}:${port}`;
		const token = getDaemonToken() || persisted;
		// Routed like create_session (agent-global, but posted to a session's /control): use the latest.
		const [latest] = this.getAgentState().sessions;
		if (!latest) throw new Error(`No session for agent "${this.name}".`);
		// Birth daemon's boot time, so the handoff waits for its replacement (see waitForRestart).
		const birthStartedAt = (await getDaemonInfo(base))?.startedAt ?? null;
		const snap = await this.send<DaemonSessionState>(latest.sessionId, { type: "deploy" });

		if (getServiceManager().kind === "none") return snap;

		// Stop the birth daemon, wait for the fixed port to free, then start the supervised unit's daemon
		// on it and wait for that replacement before reconnecting.
		await requestDaemonShutdown(base, token);
		await waitForShutdown(base);
		getServiceManager().start(this.name);
		await waitForRestart(base, birthStartedAt);

		// Reconnect onto the (same-address) supervised daemon: close the old control + session streams
		// (sessions reopen on the new daemon) and reconnect.
		this.controlStream?.close();
		for (const handle of this.sessions.values()) handle.close();
		this.sessions.clear();
		this.base = base;
		this.token = token;
		await this.openControlStream(base, token);
		return snap;
	}

	/** Open the root control stream, capture the agent snapshot from its hello, fan lifecycle frames out. */
	private async openControlStream(base: string, token: string): Promise<void> {
		this.controlStream = new SseStream(`${base}/events`, token);
		const hello = await this.controlStream.open((data) => {
			// Route each lifecycle frame to the typed `on(...)` listeners.
			const evt = JSON.parse(data) as DaemonControlEvent;
			if (evt.type === "session_added") {
				for (const listener of this.controlListeners.sessionAdded) listener(evt.session);
			} else if (evt.type === "session_removed") {
				for (const listener of this.controlListeners.sessionRemoved) listener(evt.sessionId);
			} else {
				for (const listener of this.controlListeners.sessionRenamed) listener(evt.sessionId, evt.sessionName);
			}
		});
		this.agentState = JSON.parse(hello) as DaemonAgentState;
	}

	/** Close every session stream and the control stream. */
	close(): void {
		for (const handle of this.sessions.values()) handle.close();
		this.sessions.clear();
		this.controlStream?.close();
	}

	/**
	 * Tear the agent down: uninstall the OS service (so a supervised daemon won't relaunch), ask any
	 * daemon still running to shut down (a birth daemon has no unit but is a live process), then delete
	 * the home dir. `AgentSettingsManager.delete` touches only the agent home.
	 */
	async delete(): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
		getServiceManager().uninstall(this.name);

		// Best-effort shutdown of a running daemon, read straight from agent.json (the agent may not be
		// connected). A missing/invalid config just means nothing to stop.
		const store = AgentSettingsManager.get(this.name);
		if (store) {
			const base = `http://${getDaemonHost()}:${store.config.port}`;
			await requestDaemonShutdown(base, getDaemonToken() || store.config.token);
		}

		return AgentSettingsManager.delete(this.name);
	}

	/**
	 * Restart the agent's daemon so it picks up code changes (the in-process reload rebuilds only
	 * resources, not the running binary). A supervised daemon (launchd/systemd unit) is bounced via the
	 * service manager; an unsupervised dev/birth daemon is asked to exit and respawned here. Resolves once
	 * the replacement is healthy; sessions resume from disk, so in-memory turn state is lost.
	 */
	async restart(): Promise<void> {
		const { port, token: persisted } = AgentSettingsManager.create(this.name).config;
		const base = `http://${getDaemonHost()}:${port}`;
		const token = getDaemonToken() || persisted;
		const service = getServiceManager();
		// Current daemon's boot time, so we wait for its replacement after the bounce (see waitForRestart).
		const previousStartedAt = (await getDaemonInfo(base))?.startedAt ?? null;

		if (service.kind !== "none" && (await service.isRunning(this.name))) {
			// Bounce the supervised unit: stop, wait for the fixed port to free, then start its replacement.
			service.stop(this.name);
			await waitForShutdown(base);
			service.start(this.name);
		} else {
			// Unsupervised dev/birth daemon: ask it to exit, wait for the port, then respawn it directly.
			await requestDaemonShutdown(base, token);
			await waitForShutdown(base);
			const [command, ...commandArgs] = daemonLaunchCommand(this.name);
			spawn(command, commandArgs, { detached: true, stdio: "ignore" }).unref();
		}

		await waitForRestart(base, previousStartedAt);
	}
}

/**
 * The per-session proxy the TUI/`--print` drive: verbs round-trip through `agent.send(sessionId, …)`,
 * and the session's event stream (`GET /sessions/:id/events`) arrives into the local snapshot/queue
 * caches. Reads that change rarely (resource summary, commands) are served from the cache; per-turn
 * reads (entries, messages) round-trip. Agent-global reads (config/cwd) come off the owning `Agent`.
 */
export class SessionHandle {
	private readonly agent: Agent;
	readonly sessionId: string;
	private readonly stream: SseStream;
	private snap: DaemonSessionState;
	private queue: { steer: AgentMessage[]; followUp: AgentMessage[] } = { steer: [], followUp: [] };
	private resourceSummary: ResourceSummary = { extensions: 0, skills: 0, prompts: 0, commands: 0, diagnostics: [] };
	private commands: SlashCommandInfo[] = [];
	// Compaction in-flight, tracked off the forwarded compaction_start/end frames so callers can
	// route input to the queue while a compaction runs (mirrors coding-agent's session.isCompacting).
	private compacting = false;

	private readonly handlers = new Set<(e: AgentHarnessEvent) => void>();
	onUiRequest?: (req: ExtensionUIRequest) => void;
	onLoginRequest?: (req: LoginUIRequest) => void;

	private constructor(agent: Agent, sessionId: string, stream: SseStream, snap: DaemonSessionState) {
		this.agent = agent;
		this.sessionId = sessionId;
		this.stream = stream;
		this.snap = snap;
	}

	/** Open the session's event stream and return a live handle once its `hello` snapshot lands. */
	static async open(agent: Agent, sessionId: string, stream: SseStream): Promise<SessionHandle> {
		const handle = new SessionHandle(agent, sessionId, stream, {
			sessionId,
			thinkingLevel: "off",
			scopedModels: [],
			isStreaming: false,
			messageCount: 0,
			pendingMessageCount: 0,
		});
		const hello = await stream.open((data) => handle.handleFrame(data));
		handle.snap = JSON.parse(hello) as DaemonSessionState;
		await handle.refreshResources();
		return handle;
	}

	/** Route one parsed SSE frame (post-hello): extension-UI / login request → bridge; else session event. */
	private handleFrame(data: string): void {
		const evt = JSON.parse(data) as SessionEvent | ExtensionUIRequest | LoginUIRequest;
		if (evt.type === "extension_ui_request") {
			this.onUiRequest?.(evt);
			return;
		}
		if (evt.type === "login_ui_request") {
			this.onLoginRequest?.(evt);
			return;
		}
		this.routeEvent(evt);
	}

	/** Update the caches off the stream, then fan harness events out to subscribers. */
	private routeEvent(evt: SessionEvent): void {
		switch (evt.type) {
			case "model_update":
				this.snap.model = evt.model;
				break;
			case "thinking_level_update":
				this.snap.thinkingLevel = evt.level;
				break;
			case "scoped_models_update":
				// Cache-only; not forwarded to subscribers.
				this.snap.scopedModels = evt.scopedModels;
				return;
			case "queue_update":
				this.queue = { steer: evt.steer, followUp: evt.followUp };
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				break;
		}
		for (const handler of this.handlers) handler(evt);
	}

	private async refreshResources(): Promise<void> {
		const [resourceSummary, commands] = await Promise.all([
			this.agent.send<ResourceSummary>(this.sessionId, { type: "get_resource_summary" }),
			this.agent.send<{ commands: SlashCommandInfo[] }>(this.sessionId, { type: "get_commands" }),
		]);
		this.resourceSummary = resourceSummary;
		this.commands = commands.commands;
	}

	close(): void {
		this.stream.close();
		this.agent.sessions.delete(this.sessionId);
	}

	subscribe(cb: (e: AgentHarnessEvent) => void): () => void {
		this.handlers.add(cb);
		return () => this.handlers.delete(cb);
	}

	prompt(
		message: string,
		opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		return this.agent.send(this.sessionId, {
			type: "prompt",
			message,
			images: opts?.images,
			streamingBehavior: opts?.streamingBehavior,
		});
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.agent.send(this.sessionId, { type: "compact", customInstructions });
	}

	/** Cancel an in-progress compaction (manual or auto). */
	abortCompaction(): Promise<unknown> {
		return this.agent.send(this.sessionId, { type: "abort_compaction" });
	}

	/** Whether a compaction is currently running (tracked off compaction_start/end frames). */
	get isCompacting(): boolean {
		return this.compacting;
	}

	abort(): Promise<unknown> {
		return this.agent.send(this.sessionId, { type: "abort" });
	}

	waitForIdle(): Promise<void> {
		return this.agent.send(this.sessionId, { type: "wait_for_idle" });
	}

	async reload(): Promise<void> {
		await this.agent.send(this.sessionId, { type: "reload" });
		// A reload can change config-derived state, so refresh the snapshot too.
		this.snap = await this.agent.send<DaemonSessionState>(this.sessionId, { type: "get_state" });
		await this.refreshResources();
	}

	clearQueue(): Promise<{ steering: AgentMessage[]; followUp: AgentMessage[] }> {
		return this.agent.send(this.sessionId, { type: "clear_queue" });
	}

	seedAssistantMessage(text: string): Promise<AssistantMessage> {
		return this.agent.send(this.sessionId, { type: "seed_assistant_message", text });
	}

	appendMessage(message: AgentMessage): Promise<void> {
		return this.agent.send(this.sessionId, { type: "append_message", message });
	}

	// ---- Session management the resume selector drives (agent-global; routed through this session's rail) ----
	/** Rename any stored session of the agent by id. */
	renameSession(targetSessionId: string, sessionName: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "rename_session", targetSessionId, sessionName });
	}

	/** Delete any stored session of the agent by id. */
	deleteSession(targetSessionId: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "delete_session", targetSessionId });
	}

	// ---- Plugin verbs: single-writer mutations the daemon applies, then self-reloads ----
	installPlugin(source: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "install_plugin", source });
	}

	removePlugin(source: string): Promise<{ removed: boolean }> {
		return this.agent.send(this.sessionId, { type: "remove_plugin", source });
	}

	updatePlugins(source?: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "update_plugins", source });
	}

	async onboardPlugin(source: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.agent.send<{ results: OnboardServiceResult[] }>(this.sessionId, {
			type: "onboard_plugin",
			source,
		});
		return results;
	}

	/** Per-turn read — round-trips. */
	async getEntries(): Promise<SessionTreeEntry[]> {
		const { entries } = await this.agent.send<{ entries: SessionTreeEntry[] }>(this.sessionId, {
			type: "get_entries",
		});
		return entries;
	}

	async listTools(): Promise<{ tools: ToolInfo[]; activeToolNames: string[] }> {
		return this.agent.send<{ tools: ToolInfo[]; activeToolNames: string[] }>(this.sessionId, {
			type: "get_tool_info",
		});
	}

	async listIntegrations(): Promise<IntegrationInfo[]> {
		return (
			await this.agent.send<{ integrations: IntegrationInfo[] }>(this.sessionId, { type: "get_integration_info" })
		).integrations;
	}

	async listSkills(): Promise<Skill[]> {
		return (await this.agent.send<{ skills: Skill[] }>(this.sessionId, { type: "get_skills" })).skills;
	}

	async listPlugins(): Promise<ConfiguredPlugin[]> {
		return (await this.agent.send<{ plugins: ConfiguredPlugin[] }>(this.sessionId, { type: "get_plugins" })).plugins;
	}

	async listContexts(): Promise<ContextInfo[]> {
		return (await this.agent.send<{ contexts: ContextInfo[] }>(this.sessionId, { type: "get_context_info" }))
			.contexts;
	}

	async getAvailableModels(): Promise<Model<Api>[]> {
		return (await this.agent.send<{ models: Model<Api>[] }>(this.sessionId, { type: "get_available_models" })).models;
	}

	/** Switch the live model; the daemon persists the default and emits model_update. */
	setModel(provider: string, modelId: string): Promise<Model<Api>> {
		return this.agent.send(this.sessionId, { type: "set_model", provider, modelId });
	}

	async getLoginProviderOptions(authType?: "oauth" | "api_key"): Promise<AuthSelectorProvider[]> {
		return (
			await this.agent.send<{ providers: AuthSelectorProvider[] }>(this.sessionId, {
				type: "get_login_providers",
				authType,
			})
		).providers;
	}

	async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		return (
			await this.agent.send<{ providers: AuthSelectorProvider[] }>(this.sessionId, { type: "get_logout_providers" })
		).providers;
	}

	/** Run a provider login daemon-side (credentials never cross the wire); prompts round-trip via respondLogin. */
	login(provider: string, authType: "oauth" | "api_key"): Promise<void> {
		return this.agent.send(this.sessionId, { type: "login", provider, authType });
	}

	/** Abort the in-flight `/login` flow (the client closed the login dialog). */
	loginCancel(): Promise<void> {
		return this.agent.send(this.sessionId, { type: "login_cancel" });
	}

	logout(provider: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "logout", provider });
	}

	getModel(): Model<Api> | undefined {
		return this.snap.model;
	}

	getScopedModels(): ScopedModel[] {
		return this.snap.scopedModels;
	}

	/** Switch the session-only scope; the daemon resolves the patterns and emits scoped_models_update. */
	setScopedModels(enabledModelIds: string[]): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_scoped_models", enabledModelIds });
	}

	/** Persist the agent-tier scoped-model shortlist to agent.json. */
	setEnabledModels(enabledModels: string[] | undefined): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_enabled_models", enabledModels });
	}

	getThinkingLevel(): ThinkingLevel {
		return this.snap.thinkingLevel;
	}

	/** The thinking levels the current model supports, or the full set when no model is resolved. */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.snap.model;
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_thinking_level", level });
	}

	/** Per-turn read — round-trips (only `.messages` is consumed client-side). */
	async buildSessionContext(): Promise<SessionContext> {
		const { messages } = await this.agent.send<{ messages: AgentMessage[] }>(this.sessionId, {
			type: "get_messages",
		});
		return { messages, thinkingLevel: this.snap.thinkingLevel, model: null, activeToolNames: null };
	}

	// ---- Snapshot reads — no round-trip ----
	get config(): AgentConfig {
		return this.agent.getAgentState().config;
	}

	getCwd(): string {
		return this.agent.getAgentState().cwd;
	}

	getSessionName(): string | undefined {
		return this.snap.sessionName;
	}

	/** The session's JSONL file path (the resume selector keys current-session protection on it). */
	getSessionFile(): string | undefined {
		return this.snap.sessionFile;
	}

	getResourceSummary(): ResourceSummary {
		return this.resourceSummary;
	}

	getCommands(): SlashCommandInfo[] {
		return this.commands;
	}

	getSteeringMessages(): AgentMessage[] {
		return this.queue.steer;
	}

	getFollowUpMessages(): AgentMessage[] {
		return this.queue.followUp;
	}

	// ---- Extension surface, inert client-side (the runner lives server-side) ----
	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		return new Map();
	}

	getMessageRenderer(): MessageRenderer | undefined {
		return undefined;
	}

	emitUserBash(_event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return Promise.resolve(undefined);
	}

	/** Unreachable (`getShortcuts()` is always empty); fails loud rather than fabricating a context. */
	createShortcutContext(): ExtensionContext {
		throw new Error("Extension shortcuts are not wired over the daemon.");
	}

	respondUi(id: string, answer: Record<string, unknown>): Promise<void> {
		return this.agent.respondUi(this.sessionId, id, answer);
	}

	respondLogin(id: string, answer: Record<string, unknown>): Promise<void> {
		return this.agent.respondLogin(this.sessionId, id, answer);
	}
}

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A healthy daemon's `/health` info at `base` (`pid` + boot `startedAt`), or null if none answers. */
async function getDaemonInfo(base: string): Promise<{ pid: number; startedAt: string } | null> {
	try {
		const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
		if (!response.ok) return null;
		const { status, pid, startedAt } = (await response.json()) as {
			status?: string;
			pid?: number;
			startedAt?: string;
		};
		return status === "ok" && pid !== undefined && startedAt !== undefined ? { pid, startedAt } : null;
	} catch {
		return null;
	}
}

/** `GET /health` (no auth) answers `{status:"ok"}` while the daemon at `base` is listening. */
export async function isHealthy(base: string): Promise<boolean> {
	try {
		const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
		if (!response.ok) return false;
		return ((await response.json()) as { status?: string }).status === "ok";
	} catch {
		return false;
	}
}

/** Poll `/health` until the daemon at `base` is listening (or time out). */
export async function waitForHealth(base: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isHealthy(base)) return;
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon at ${base} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

/** Poll `/health` until the daemon at `base` stops responding (or time out) — the port is then free. */
export async function waitForShutdown(base: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await isHealthy(base))) return;
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon at ${base} did not shut down within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

/**
 * Poll `/health` until `base` reports a `startedAt` other than `since` — a real replacement, not the old
 * daemon still answering over a keep-alive socket before its replacement has bound the reused port (which
 * would let the caller's reconnect race into the port-handoff gap and "fetch failed").
 */
export async function waitForRestart(base: string, since: string | null): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const info = await getDaemonInfo(base);
		if (info && info.startedAt !== since) return;
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon at ${base} did not restart within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

/** Best-effort: ask a running daemon to self-exit. Session-scoped on the wire, so post it to any session. */
export async function requestDaemonShutdown(base: string, token: string): Promise<void> {
	try {
		const list = await fetch(`${base}/sessions`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(2000),
		});
		if (!list.ok) return;
		const sessionId = ((await list.json()) as DaemonAgentState).sessions[0]?.sessionId;
		if (!sessionId) return;
		await fetch(`${base}/sessions/${sessionId}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ type: "shutdown" }),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// Best-effort: the daemon is already down or unreachable.
	}
}
