/**
 * The `@opsyhq/steward` client surface:
 *   - `Steward`      — the agent collection (`list`/`get`/`create`).
 *   - `Agent`        — one agent: registry data + lifecycle, owns a private `Connection`.
 *   - `Connection`   — the `fetch`/SSE transport to a per-agent daemon (private to `Agent`).
 *   - `AgentSession` — the per-conversation proxy the TUI and `--print` drive.
 */

import { spawn } from "node:child_process";
import {
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage, SessionContext, SessionTreeEntry, ThinkingLevel } from "@opsyhq/agent";
import type { ContextInfo, IntegrationInfo } from "./core/agent-runtime.ts";
import { type AgentConfig, AgentSettingsManager } from "./core/agent-settings-manager.ts";
import { type DaemonConfig, deleteDaemonConfig, loadDaemonConfig } from "./core/daemon-config.ts";
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
import type { ScopedModel } from "./core/model-resolver.ts";
import type { ConfiguredPlugin } from "./core/plugin-manager.ts";
import { daemonLaunchCommand, getServiceManager } from "./core/service/service-manager.ts";
import type { Skill } from "./core/skills.ts";
import type {
	AuthSelectorProvider,
	DaemonCommand,
	DaemonResponse,
	DaemonSessionState,
	ExtensionUIRequest,
	OnboardServiceResult,
	ScopedModelsUpdateEvent,
} from "./types.ts";

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 150;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ConnectionEvent = AgentHarnessEvent | ScopedModelsUpdateEvent;

/** Top level: the agent collection on disk. Holds no required state. */
export class Steward {
	/** Every agent under the agents root, as handles. */
	list(): Agent[] {
		return AgentSettingsManager.list().map((store) => new Agent(store.config));
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
}

/** One agent: registry data, per-agent lifecycle, and the conversation factory over a private `Connection`. */
export class Agent {
	readonly config: AgentConfig;
	private connection?: Connection;
	private conversation?: AgentSession;

	constructor(config: AgentConfig) {
		this.config = config;
	}

	get name(): string {
		return this.config.name;
	}

	/**
	 * Find the agent's live daemon (config → /health) and attach, else spawn a detached `daemon <name>`
	 * (the same command the OS service unit runs) and wait for it. Returns the live conversation.
	 */
	async open(): Promise<AgentSession> {
		const existing = loadDaemonConfig(this.name);
		if (existing && (await isHealthy(existing.port))) {
			return this.attach(`http://127.0.0.1:${existing.port}`, existing.token);
		}

		// The launch command goes through the running binary, since `steward` isn't on PATH in dev.
		const [command, ...commandArgs] = daemonLaunchCommand(this.name);
		const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
		child.unref();

		const config = await waitForHealth(this.name);
		return this.attach(`http://127.0.0.1:${config.port}`, config.token);
	}

	/** Attach to a known daemon endpoint and return its live conversation. */
	async attach(base: string, token: string): Promise<AgentSession> {
		this.connection = await Connection.attach(base, token);
		return this.createConversation();
	}

	/** The live conversation, or undefined if none created yet. Find-only — never creates. */
	getConversation(): AgentSession | undefined {
		return this.conversation;
	}

	/** Build a conversation proxy on the live connection and make it the live one. */
	async createConversation(): Promise<AgentSession> {
		if (!this.connection) throw new Error("Agent connection not open. Call open()/attach() first.");
		this.conversation = await AgentSession.create(this.connection);
		return this.conversation;
	}

	/**
	 * Tear the agent down: uninstall the OS service (so a supervised daemon won't relaunch), SIGTERM
	 * any daemon still running (a birth daemon has no unit but is a live process), delete the home
	 * dir, then drop the daemon config. `AgentSettingsManager.delete` touches only the agent home — never the shared
	 * credential dir.
	 */
	delete(): { ok: boolean; method: "trash" | "unlink"; error?: string } {
		getServiceManager().uninstall(this.name);

		const daemon = loadDaemonConfig(this.name);
		if (daemon) {
			try {
				process.kill(daemon.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}

		const result = AgentSettingsManager.delete(this.name);
		if (result.ok) deleteDaemonConfig(this.name);
		return result;
	}
}

/**
 * The `fetch`/SSE transport to a per-agent daemon: the single `fetch` site (`send`), the `GET /events`
 * stream and its frame parsing, the cached hello snapshot, and the raw fan-out to subscribers. Private
 * to `Agent`; `AgentSession` rides it.
 */
export class Connection {
	private snapshot!: DaemonSessionState;
	private readonly subscribers = new Set<(e: ConnectionEvent) => void>();
	private abortController?: AbortController;

	onUiRequest?: (req: ExtensionUIRequest) => void;

	// Not readonly: `reconnect()` re-points the transport at a different daemon (the deploy handoff).
	private base: string;
	private token: string;

	private constructor(base: string, token: string) {
		this.base = base;
		this.token = token;
	}

	static async attach(base: string, token: string): Promise<Connection> {
		const connection = new Connection(base, token);
		await connection.connect();
		return connection;
	}

	getSnapshot(): DaemonSessionState {
		return this.snapshot;
	}

	subscribe(cb: (e: ConnectionEvent) => void): () => void {
		this.subscribers.add(cb);
		return () => this.subscribers.delete(cb);
	}

	async send<T>(cmd: DaemonCommand): Promise<T> {
		const response = await fetch(`${this.base}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify(cmd),
		});
		const body = (await response.json()) as DaemonResponse;
		if (!body.success) throw new Error(body.error);
		return body.data as T;
	}

	/** Open the SSE stream and resolve once the hello snapshot lands; consume frames in the background. */
	private async connect(): Promise<void> {
		this.abortController = new AbortController();
		const response = await fetch(`${this.base}/events`, {
			headers: { authorization: `Bearer ${this.token}` },
			signal: this.abortController.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Failed to open daemon event stream (HTTP ${response.status}).`);
		}
		const hello = deferred<void>();
		void this.consume(response.body, hello);
		await hello.promise;
	}

	/**
	 * Re-point the transport at a different daemon (deploy handoff). The subscriber set survives; the
	 * fresh `connect()` delivers the new hello snapshot (read back via `getSnapshot`).
	 */
	async reconnect(port: number, token: string): Promise<void> {
		this.close();
		this.base = `http://127.0.0.1:${port}`;
		this.token = token;
		await this.connect();
	}

	close(): void {
		this.abortController?.abort();
	}

	private async consume(body: ReadableStream<Uint8Array>, hello: Deferred<void>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of body) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					// A single malformed frame must not kill the stream: skip it, keep consuming.
					try {
						this.handleFrame(buffer.slice(0, boundary), hello);
					} catch {}
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// The stream ended or was aborted.
		}
	}

	/** Parse one SSE frame (`event:`/`data:`/comment lines; `data:` lines join with `\n`) and route it. */
	private handleFrame(raw: string, hello: Deferred<void>): void {
		let event = "message";
		let data = "";
		for (const line of raw.split("\n")) {
			if (line.startsWith(":")) continue; // keepalive comment
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
		}
		if (!data) return;

		if (event === "hello") {
			this.snapshot = JSON.parse(data) as DaemonSessionState;
			hello.resolve();
			return;
		}

		const evt = JSON.parse(data) as ConnectionEvent | ExtensionUIRequest;
		if (evt.type === "extension_ui_request") {
			// Routed to the UI bridge, not the event subscribers.
			this.onUiRequest?.(evt);
			return;
		}
		for (const subscriber of this.subscribers) subscriber(evt);
	}

	/** Answer a parked daemon-side dialog (fire-and-forget). */
	async respondUi(id: string, answer: Record<string, unknown>): Promise<void> {
		await fetch(`${this.base}/ui-response`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ type: "extension_ui_response", id, ...answer }),
		});
	}
}

/**
 * The per-conversation proxy the TUI/`--print` drive: verbs round-trip through `connection.send`, and
 * the event stream arrives via `connection.subscribe` into the local snapshot/queue caches. Reads that
 * change rarely (`config`/`cwd`, resource summary, commands) are served from the cached snapshot;
 * per-turn reads (entries, messages) round-trip.
 */
export class AgentSession {
	private readonly connection: Connection;
	private snap: DaemonSessionState;
	private queue: { steer: AgentMessage[]; followUp: AgentMessage[] } = { steer: [], followUp: [] };
	private resourceSummary: ResourceSummary = { extensions: 0, skills: 0, prompts: 0, commands: 0, diagnostics: [] };
	private commands: SlashCommandInfo[] = [];

	private readonly handlers = new Set<(e: AgentHarnessEvent) => void>();
	private readonly connectionUnsubscribe: () => void;

	private constructor(connection: Connection) {
		this.connection = connection;
		// Seed from the hello snapshot; events keep it fresh.
		this.snap = connection.getSnapshot();
		this.connectionUnsubscribe = connection.subscribe((evt) => this.routeEvent(evt));
	}

	static async create(connection: Connection): Promise<AgentSession> {
		const session = new AgentSession(connection);
		await session.refreshResources();
		return session;
	}

	get onUiRequest(): ((req: ExtensionUIRequest) => void) | undefined {
		return this.connection.onUiRequest;
	}
	set onUiRequest(handler: ((req: ExtensionUIRequest) => void) | undefined) {
		this.connection.onUiRequest = handler;
	}

	/** Update the caches off the stream, then fan harness events out to subscribers. */
	private routeEvent(evt: ConnectionEvent): void {
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
		}
		for (const handler of this.handlers) handler(evt);
	}

	private async refreshResources(): Promise<void> {
		const [resourceSummary, commands] = await Promise.all([
			this.connection.send<ResourceSummary>({ type: "get_resource_summary" }),
			this.connection.send<{ commands: SlashCommandInfo[] }>({ type: "get_commands" }),
		]);
		this.resourceSummary = resourceSummary;
		this.commands = commands.commands;
	}

	close(): void {
		this.connectionUnsubscribe();
		this.connection.close();
	}

	subscribe(cb: (e: AgentHarnessEvent) => void): () => void {
		this.handlers.add(cb);
		return () => this.handlers.delete(cb);
	}

	prompt(
		message: string,
		opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		return this.connection.send({
			type: "prompt",
			message,
			images: opts?.images,
			streamingBehavior: opts?.streamingBehavior,
		});
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.connection.send({ type: "compact", customInstructions });
	}

	abort(): Promise<unknown> {
		return this.connection.send({ type: "abort" });
	}

	waitForIdle(): Promise<void> {
		return this.connection.send({ type: "wait_for_idle" });
	}

	async reload(): Promise<void> {
		await this.connection.send({ type: "reload" });
		// A reload can change config-derived state, so refresh the snapshot too.
		this.snap = await this.connection.send<DaemonSessionState>({ type: "get_state" });
		await this.refreshResources();
	}

	async newSession(opts: { reason: "deploy" | "new" }): Promise<void> {
		this.snap = await this.connection.send<DaemonSessionState>({ type: "new_session", reason: opts.reason });
		await this.refreshResources();
	}

	/**
	 * Persist the deploy. The daemon flips the latch and registers the OS service; with a real backend
	 * it also starts a supervised daemon on a new port, so we reconnect onto it (told apart from the
	 * birth daemon by pid) and stop the birth daemon. The `none` backend keeps the same daemon.
	 */
	async deploy(): Promise<void> {
		// Capture the birth daemon before its config is overwritten by the supervised one.
		const birth = loadDaemonConfig(this.config.name);

		this.snap = await this.connection.send<DaemonSessionState>({ type: "deploy" });

		if (getServiceManager().kind === "none") {
			await this.refreshResources();
			return;
		}

		// Wait for the supervised daemon (a different pid), then move our transport onto it.
		const supervised = await waitForHealth(this.config.name, (cfg) => cfg.pid !== birth?.pid);
		await this.connection.reconnect(supervised.port, supervised.token);
		this.snap = this.connection.getSnapshot();
		await this.refreshResources();

		// Stop the birth daemon; its shutdown won't touch the now-supervised config.
		if (birth) {
			try {
				process.kill(birth.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}

	clearQueue(): Promise<{ steering: AgentMessage[]; followUp: AgentMessage[] }> {
		return this.connection.send({ type: "clear_queue" });
	}

	seedAssistantMessage(text: string): Promise<AssistantMessage> {
		return this.connection.send({ type: "seed_assistant_message", text });
	}

	appendMessage(message: AgentMessage): Promise<void> {
		return this.connection.send({ type: "append_message", message });
	}

	// ---- Plugin verbs: single-writer mutations the daemon applies, then self-reloads ----
	installPlugin(source: string): Promise<void> {
		return this.connection.send({ type: "install_plugin", source });
	}

	removePlugin(source: string): Promise<{ removed: boolean }> {
		return this.connection.send({ type: "remove_plugin", source });
	}

	updatePlugins(source?: string): Promise<void> {
		return this.connection.send({ type: "update_plugins", source });
	}

	async onboardPlugin(source: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.connection.send<{ results: OnboardServiceResult[] }>({
			type: "onboard_plugin",
			source,
		});
		return results;
	}

	/** Per-turn read — round-trips. */
	async getEntries(): Promise<SessionTreeEntry[]> {
		const { entries } = await this.connection.send<{ entries: SessionTreeEntry[] }>({ type: "get_entries" });
		return entries;
	}

	async listTools(): Promise<{ tools: ToolInfo[]; activeToolNames: string[] }> {
		return this.connection.send<{ tools: ToolInfo[]; activeToolNames: string[] }>({ type: "get_tool_info" });
	}

	async listIntegrations(): Promise<IntegrationInfo[]> {
		return (await this.connection.send<{ integrations: IntegrationInfo[] }>({ type: "get_integration_info" }))
			.integrations;
	}

	async listSkills(): Promise<Skill[]> {
		return (await this.connection.send<{ skills: Skill[] }>({ type: "get_skills" })).skills;
	}

	async listPlugins(): Promise<ConfiguredPlugin[]> {
		return (await this.connection.send<{ plugins: ConfiguredPlugin[] }>({ type: "get_plugins" })).plugins;
	}

	async listContexts(): Promise<ContextInfo[]> {
		return (await this.connection.send<{ contexts: ContextInfo[] }>({ type: "get_context_info" })).contexts;
	}

	async getAvailableModels(): Promise<Model<Api>[]> {
		return (await this.connection.send<{ models: Model<Api>[] }>({ type: "get_available_models" })).models;
	}

	/** Switch the live model; the daemon persists the default and emits model_update. */
	setModel(provider: string, modelId: string): Promise<Model<Api>> {
		return this.connection.send({ type: "set_model", provider, modelId });
	}

	async getLoginProviderOptions(authType?: "oauth" | "api_key"): Promise<AuthSelectorProvider[]> {
		return (
			await this.connection.send<{ providers: AuthSelectorProvider[] }>({ type: "get_login_providers", authType })
		).providers;
	}

	async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		return (await this.connection.send<{ providers: AuthSelectorProvider[] }>({ type: "get_logout_providers" }))
			.providers;
	}

	/** Run a provider login daemon-side (credentials never cross the wire); OAuth prompts round-trip via respondUi. */
	login(provider: string, authType: "oauth" | "api_key"): Promise<void> {
		return this.connection.send({ type: "login", provider, authType });
	}

	logout(provider: string): Promise<void> {
		return this.connection.send({ type: "logout", provider });
	}

	getModel(): Model<Api> | undefined {
		return this.snap.model;
	}

	getScopedModels(): ScopedModel[] {
		return this.snap.scopedModels;
	}

	/** Switch the session-only scope; the daemon resolves the patterns and emits scoped_models_update. */
	setScopedModels(enabledModelIds: string[]): Promise<void> {
		return this.connection.send({ type: "set_scoped_models", enabledModelIds });
	}

	/** Persist the agent-tier scoped-model shortlist to agent.json. */
	setEnabledModels(enabledModels: string[] | undefined): Promise<void> {
		return this.connection.send({ type: "set_enabled_models", enabledModels });
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
		return this.connection.send({ type: "set_thinking_level", level });
	}

	/** Per-turn read — round-trips (only `.messages` is consumed client-side). */
	async buildSessionContext(): Promise<SessionContext> {
		const { messages } = await this.connection.send<{ messages: AgentMessage[] }>({ type: "get_messages" });
		return { messages, thinkingLevel: this.snap.thinkingLevel, model: null, activeToolNames: null };
	}

	// ---- Snapshot reads — no round-trip ----
	get config(): DaemonSessionState["config"] {
		return this.snap.config;
	}

	getCwd(): string {
		return this.snap.cwd;
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
		return this.connection.respondUi(id, answer);
	}
}

/** `GET /health` (no auth) answers `{status:"ok"}` while the daemon is listening. */
export async function isHealthy(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) return false;
		const body = (await response.json()) as { status?: string };
		return body.status === "ok";
	} catch {
		return false;
	}
}

/**
 * Poll the config + `/health` until a matching daemon answers (or time out). The optional predicate
 * narrows which config counts — the deploy handoff waits for the supervised daemon (a pid different
 * from the outgoing birth daemon's).
 */
export async function waitForHealth(
	name: string,
	predicate: (config: DaemonConfig) => boolean = () => true,
): Promise<{ pid: number; port: number; token: string }> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const config = loadDaemonConfig(name);
		if (config && predicate(config) && (await isHealthy(config.port))) {
			return { pid: config.pid, port: config.port, token: config.token };
		}
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon for "${name}" did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}
