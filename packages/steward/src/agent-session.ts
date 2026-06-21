/**
 * AgentSession — the single `fetch`/SSE seam between a client (the interactive TUI and `--print`)
 * and a per-agent daemon. It is concrete and exposes exactly the methods the TUI calls; it is NOT a
 * reusable contract and changes when the TUI changes. Construction is `Agent.open()`/`Agent.attach()`
 * (find-or-start lives on `Agent`); this is the live connection it hands back.
 *
 *   - `send()`  — every `POST /control` command goes through here (the one place `fetch` lives).
 *   - `connect()` — opens `GET /events` (SSE) and keeps a cached snapshot fresh; forwards harness
 *      events to subscribers and routes `extension_ui_request` to `onUiRequest`.
 *   - reads that change rarely (`config`/`cwd`, the loaded-resource summary, the command set) are
 *      served from the cached hello/get_state snapshot; per-turn reads (entries, messages) round-trip.
 */

import {
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage, SessionContext, SessionTreeEntry, ThinkingLevel } from "@opsyhq/agent";
import { type DaemonConfig, loadDaemonConfig } from "./core/daemon-config.ts";
import { THINKING_LEVELS } from "./core/defaults.ts";
import type { ResourceSummary } from "./core/diagnostics.ts";
import type {
	ExtensionCommandContext,
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
import { getServiceManager } from "./core/service/service-manager.ts";
import type { ContextInfo, IntegrationInfo } from "./core/session-host.ts";
import type { Skill } from "./core/skills.ts";
import type {
	DaemonCommand,
	DaemonResponse,
	DaemonSessionState,
	ExtensionUIRequest,
	OnboardServiceResult,
	ScopedModelsUpdateEvent,
} from "./types.ts";

/** How long `Agent.open()` waits for a freshly spawned daemon to answer `/health`. */
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

export class AgentSession {
	private snap!: DaemonSessionState;
	private queue: { steer: AgentMessage[]; followUp: AgentMessage[] } = { steer: [], followUp: [] };
	private resourceSummary: ResourceSummary = { extensions: 0, skills: 0, prompts: 0, commands: 0, diagnostics: [] };
	private commands: SlashCommandInfo[] = [];

	private readonly handlers = new Set<(e: AgentHarnessEvent) => void>();
	private abortController?: AbortController;

	/** The extension-UI request stream's client half. Wired by `InteractiveMode`. */
	onUiRequest?: (req: ExtensionUIRequest) => void;

	// Not readonly: `reconnect()` re-points the transport at a different daemon (the deploy handoff).
	private base: string;
	private token: string;

	private constructor(base: string, token: string) {
		this.base = base;
		this.token = token;
	}

	/** Attach to a known, already-running daemon: open SSE, take the hello snapshot, warm caches. */
	static async attach(base: string, token: string): Promise<AgentSession> {
		const session = new AgentSession(base, token);
		await session.connect();
		await session.refreshResources();
		return session;
	}

	// ---- The single transport seam ----
	private async send<T>(cmd: DaemonCommand): Promise<T> {
		const response = await fetch(`${this.base}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify(cmd),
		});
		const body = (await response.json()) as DaemonResponse;
		if (!body.success) throw new Error(body.error);
		return body.data as T;
	}

	/** Open the SSE stream and resolve once the hello snapshot lands. Consumes frames in the background. */
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
			// The stream ended or was aborted; the consumer stops and the TUI exits on its own.
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
			this.snap = JSON.parse(data) as DaemonSessionState;
			hello.resolve();
			return;
		}
		this.routeEvent(JSON.parse(data));
	}

	private routeEvent(evt: AgentHarnessEvent | ExtensionUIRequest | ScopedModelsUpdateEvent): void {
		switch (evt.type) {
			case "extension_ui_request":
				// Not an AgentHarnessEvent — hand to the UI bridge and do NOT forward to handlers.
				this.onUiRequest?.(evt);
				return;
			case "model_update":
				this.snap.model = evt.model;
				break;
			case "thinking_level_update":
				this.snap.thinkingLevel = evt.level;
				break;
			case "scoped_models_update":
				// Host-originated, not an AgentHarnessEvent — refresh the cached scope and do NOT forward.
				this.snap.scopedModels = evt.scopedModels;
				return;
			case "queue_update":
				this.queue = { steer: evt.steer, followUp: evt.followUp };
				break;
		}
		for (const handler of this.handlers) handler(evt);
	}

	/** Re-read the resource-derived caches (commands + loaded-resource summary). */
	private async refreshResources(): Promise<void> {
		const [resourceSummary, commands] = await Promise.all([
			this.send<ResourceSummary>({ type: "get_resource_summary" }),
			this.send<{ commands: SlashCommandInfo[] }>({ type: "get_commands" }),
		]);
		this.resourceSummary = resourceSummary;
		this.commands = commands.commands;
	}

	/** Abort the SSE stream so the process can exit (used by the one-shot `--print` client). */
	close(): void {
		this.abortController?.abort();
	}

	/**
	 * Move the transport onto a different daemon (the deploy handoff): drop the current SSE, re-point
	 * at the new endpoint, reopen. The handler set survives, so subscribers keep receiving events; the
	 * fresh `connect()` delivers the new daemon's hello snapshot.
	 */
	async reconnect(port: number, token: string): Promise<void> {
		this.close();
		this.base = `http://127.0.0.1:${port}`;
		this.token = token;
		await this.connect();
		await this.refreshResources();
	}

	// ---- What InteractiveMode calls (was sessionHost.* / harness.*) ----
	subscribe(cb: (e: AgentHarnessEvent) => void): () => void {
		this.handlers.add(cb);
		return () => this.handlers.delete(cb);
	}

	prompt(
		message: string,
		opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		return this.send({ type: "prompt", message, images: opts?.images, streamingBehavior: opts?.streamingBehavior });
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.send({ type: "compact", customInstructions });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" });
	}

	waitForIdle(): Promise<void> {
		return this.send({ type: "wait_for_idle" });
	}

	async reload(): Promise<void> {
		await this.send({ type: "reload" });
		// Refresh the snapshot too (not just resources): a reload can change config-derived state.
		this.snap = await this.send<DaemonSessionState>({ type: "get_state" });
		await this.refreshResources();
	}

	async newSession(opts: { reason: "deploy" | "new" }): Promise<void> {
		this.snap = await this.send<DaemonSessionState>({ type: "new_session", reason: opts.reason });
		await this.refreshResources();
	}

	/**
	 * Persist the deploy (the human's Yes). The daemon flips the latch, registers the OS service, and
	 * swaps to a fresh deployed session. With a real backend it also starts the supervised daemon (on
	 * its own OS-assigned port); we then reconnect onto it and stop the birth daemon. The two are told
	 * apart by pid: both bind ephemeral ports, so the supervised daemon is simply the one whose config
	 * pid differs from the birth daemon's. With the `none` backend there is no supervisor — the same
	 * daemon stays, so we just refresh the snapshot.
	 */
	async deploy(): Promise<void> {
		// Capture the birth daemon before its deploy handler starts the supervised one (which overwrites
		// the shared config), so we can both tell the two apart and stop the birth daemon afterward.
		const birth = loadDaemonConfig(this.config.name);

		this.snap = await this.send<DaemonSessionState>({ type: "deploy" });

		if (getServiceManager().kind === "none") {
			await this.refreshResources();
			return;
		}

		// Wait for the supervised daemon — a different pid than the birth daemon, answering /health —
		// then move our transport onto it. (waitForHealth's /health check skips the transient
		// pre-bind config frame whose port is still 0.)
		const supervised = await waitForHealth(this.config.name, (cfg) => cfg.pid !== birth?.pid);
		await this.reconnect(supervised.port, supervised.token);

		// The birth daemon has handed off; stop it. Its shutdown won't touch the now-supervised config
		// (no daemon deletes the config on shutdown — it's a discovery hint the successor already owns).
		if (birth) {
			try {
				process.kill(birth.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}

	clearQueue(): Promise<{ steering: AgentMessage[]; followUp: AgentMessage[] }> {
		return this.send({ type: "clear_queue" });
	}

	seedAssistantMessage(text: string): Promise<AssistantMessage> {
		return this.send({ type: "seed_assistant_message", text });
	}

	appendMessage(message: AgentMessage): Promise<void> {
		return this.send({ type: "append_message", message });
	}

	// ---- Plugin verbs — single-writer mutations routed to the daemon ----
	// The daemon runs the install/onboard primitive against its own live resources/accounts and
	// reloads itself, so a running daemon never goes stale (the reason these aren't a local CLI write).
	installPlugin(source: string): Promise<void> {
		return this.send({ type: "install_plugin", source });
	}

	removePlugin(source: string): Promise<{ removed: boolean }> {
		return this.send({ type: "remove_plugin", source });
	}

	updatePlugins(source?: string): Promise<void> {
		return this.send({ type: "update_plugins", source });
	}

	async onboardPlugin(source: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.send<{ results: OnboardServiceResult[] }>({ type: "onboard_plugin", source });
		return results;
	}

	/** Per-turn read — the session tree changes every turn, so it round-trips. */
	async getEntries(): Promise<SessionTreeEntry[]> {
		const { entries } = await this.send<{ entries: SessionTreeEntry[] }>({ type: "get_entries" });
		return entries;
	}

	// ---- Granular capability reads — the agent detail page round-trips these once on open ----
	/** Tools the agent has (info view) plus the names of the currently-active ones. */
	async listTools(): Promise<{ tools: ToolInfo[]; activeToolNames: string[] }> {
		return this.send<{ tools: ToolInfo[]; activeToolNames: string[] }>({ type: "get_tool_info" });
	}

	async listIntegrations(): Promise<IntegrationInfo[]> {
		return (await this.send<{ integrations: IntegrationInfo[] }>({ type: "get_integration_info" })).integrations;
	}

	async listSkills(): Promise<Skill[]> {
		return (await this.send<{ skills: Skill[] }>({ type: "get_skills" })).skills;
	}

	async listPlugins(): Promise<ConfiguredPlugin[]> {
		return (await this.send<{ plugins: ConfiguredPlugin[] }>({ type: "get_plugins" })).plugins;
	}

	async listContexts(): Promise<ContextInfo[]> {
		return (await this.send<{ contexts: ContextInfo[] }>({ type: "get_context_info" })).contexts;
	}

	/** Auth-filtered models the daemon's registry exposes — the single-pick selector's candidates. */
	async getAvailableModels(): Promise<Model<Api>[]> {
		return (await this.send<{ models: Model<Api>[] }>({ type: "get_available_models" })).models;
	}

	/** Switch the live model; the daemon resolves the pair, persists the default, and emits model_update. */
	setModel(provider: string, modelId: string): Promise<Model<Api>> {
		return this.send({ type: "set_model", provider, modelId });
	}

	/** The live model from the cached snapshot (kept fresh by the model_update frame). */
	getModel(): Model<Api> | undefined {
		return this.snap.model;
	}

	/** The session's model scope from the cached snapshot (kept fresh by the scoped_models_update frame). */
	getScopedModels(): ScopedModel[] {
		return this.snap.scopedModels;
	}

	/** Switch the session-only scope; the daemon resolves the patterns and emits scoped_models_update. */
	setScopedModels(enabledModelIds: string[]): Promise<void> {
		return this.send({ type: "set_scoped_models", enabledModelIds });
	}

	/** Persist the agent-tier scoped-model shortlist to agent.json. */
	setEnabledModels(enabledModels: string[] | undefined): Promise<void> {
		return this.send({ type: "set_enabled_models", enabledModels });
	}

	/** The live thinking level from the cached snapshot (kept fresh by the thinking_level_update frame). */
	getThinkingLevel(): ThinkingLevel {
		return this.snap.thinkingLevel;
	}

	/**
	 * The thinking levels the current model supports (the daemon clamps internally). Falls back to
	 * the full token set when no model is resolved, mirroring the in-process selector.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.snap.model;
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	/** Switch the live thinking level; the daemon clamps it to the model and emits thinking_level_update. */
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.send({ type: "set_thinking_level", level });
	}

	/** Per-turn read — the flattened transcript round-trips (only `.messages` is consumed client-side). */
	async buildSessionContext(): Promise<SessionContext> {
		const { messages } = await this.send<{ messages: AgentMessage[] }>({ type: "get_messages" });
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

	// ---- Extension surface, narrowed so no runner object leaks into the TUI ----
	// Extension shortcuts / message renderers / user-bash interception ride the extension runner,
	// which lives server-side, so they are inert here.
	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		return new Map();
	}

	getMessageRenderer(): MessageRenderer | undefined {
		return undefined;
	}

	emitUserBash(_event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return Promise.resolve(undefined);
	}

	/**
	 * Context for an extension shortcut handler. Unreachable — `getShortcuts()` returns an empty
	 * map, so no handler is ever invoked — and fails loud rather than fabricating a context.
	 */
	createShortcutContext(): ExtensionCommandContext {
		throw new Error("Extension shortcuts are not wired over the daemon.");
	}

	// ---- The extension-UI round-trip's client half ----
	/** Answer a parked daemon-side dialog (fire-and-forget). */
	async respondUi(id: string, answer: Record<string, unknown>): Promise<void> {
		await fetch(`${this.base}/ui-response`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ type: "extension_ui_response", id, ...answer }),
		});
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
 * from the outgoing birth daemon's), ignoring the birth daemon's soon-to-be-overwritten config.
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
