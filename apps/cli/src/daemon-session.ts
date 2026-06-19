/**
 * DaemonSession — the single `fetch`/SSE seam between the interactive TUI (and `--print`) and a
 * per-agent daemon. It is concrete, `apps/cli`-local, and exposes exactly the methods the TUI calls;
 * it is NOT a reusable contract and changes when the TUI changes.
 *
 *   - `send()`  — every `POST /control` command goes through here (the one place `fetch` lives).
 *   - `connect()` — opens `GET /events` (SSE) and keeps a cached snapshot fresh; forwards harness
 *      events to subscribers and routes `extension_ui_request` to `onUiRequest`.
 *   - reads that change rarely (`config`/`cwd`, the loaded-resource summary, the command set) are
 *      served from the cached hello/get_state snapshot; per-turn reads (entries, messages) round-trip.
 *
 * Lifecycle (`open`) is intentionally minimal: read the daemon config → /health → attach, else spawn
 * a detached `daemon` and poll /health.
 */

import { spawn } from "node:child_process";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage, SessionContext, SessionTreeEntry } from "@opsyhq/agent";
import {
	type DaemonCommand,
	type DaemonConfig,
	type DaemonResponse,
	type DaemonSessionState,
	type ExtensionCommandContext,
	type ExtensionShortcut,
	type ExtensionUIRequest,
	getServiceManager,
	type KeyId,
	loadDaemonConfig,
	type MessageRenderer,
	type OnboardServiceResult,
	type ResourceSummary,
	type SlashCommandInfo,
	type UserBashEvent,
	type UserBashEventResult,
} from "@opsyhq/steward";

/** How long `open()` waits for a freshly spawned daemon to answer `/health`. */
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

export class DaemonSession {
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
	static async attach(base: string, token: string): Promise<DaemonSession> {
		const session = new DaemonSession(base, token);
		await session.connect();
		await session.refreshResources();
		return session;
	}

	/**
	 * Resolve the agent's daemon (config → /health) and attach, spawning a detached daemon if none is
	 * live.
	 */
	static async open(name: string): Promise<DaemonSession> {
		const existing = loadDaemonConfig(name);
		if (existing && (await isHealthy(existing.port))) {
			return DaemonSession.attach(`http://127.0.0.1:${existing.port}`, existing.token);
		}

		// Not live → spawn `steward daemon <name>` detached. `steward` is not on PATH in dev, so go
		// through the running binary (process.execPath + the resolved cli.js off argv[1]).
		const child = spawn(process.execPath, [process.argv[1], "daemon", name], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();

		const config = await waitForHealth(name);
		return DaemonSession.attach(`http://127.0.0.1:${config.port}`, config.token);
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

	private routeEvent(evt: AgentHarnessEvent | ExtensionUIRequest): void {
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

	prompt(message: string, opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }): Promise<void> {
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

	// ---- Package / integration verbs — single-writer mutations routed to the daemon ----
	// The daemon runs the install/onboard primitive against its own live resources/accounts and
	// reloads itself, so a running daemon never goes stale (the reason these aren't a local CLI write).
	installPackage(source: string): Promise<void> {
		return this.send({ type: "install_package", source });
	}

	removePackage(source: string): Promise<{ removed: boolean }> {
		return this.send({ type: "remove_package", source });
	}

	updatePackages(source?: string): Promise<void> {
		return this.send({ type: "update_packages", source });
	}

	async onboardPackage(source: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.send<{ results: OnboardServiceResult[] }>({ type: "onboard_package", source });
		return results;
	}

	async onboardIntegration(service: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.send<{ results: OnboardServiceResult[] }>({
			type: "onboard_integration",
			service,
		});
		return results;
	}

	/** Per-turn read — the session tree changes every turn, so it round-trips. */
	async getEntries(): Promise<SessionTreeEntry[]> {
		const { entries } = await this.send<{ entries: SessionTreeEntry[] }>({ type: "get_entries" });
		return entries;
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
async function isHealthy(port: number): Promise<boolean> {
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
async function waitForHealth(
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
