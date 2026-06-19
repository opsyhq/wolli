/**
 * Daemon server + runner.
 *
 * `runDaemon(name, opts)` resolves the agent's model/auth, starts its `SessionHost`, then binds a
 * long-running loopback HTTP/SSE server around it and blocks until a signal tears it down:
 *
 *   - `GET /events`  (SSE)  — the curated event stream + async prompt acks;
 *   - `POST /control`       — commands, whose sync response is the HTTP body;
 *   - `GET /health`         — liveness, no auth.
 *
 * `SessionHost` owns every lifecycle concern (start/newSession/reload/cleanup); the server is a
 * thin wrapper that calls into it. The `@opsyhq/cli` client's hidden `daemon` subcommand and every
 * OS service unit invoke `runDaemon`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import type { AgentHarness, AgentHarnessEvent, ThinkingLevel } from "@opsyhq/agent";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { APP_NAME, ENV_DAEMON_TOKEN, getAgentDir, VERSION } from "../config.ts";
import { type AgentConfig, agentExists, deployAgent, isDeployed, loadAgentConfig } from "../core/agent-config.ts";
import { createAgentPluginManager } from "../core/agent-plugin-manager.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { loadDaemonConfig, saveDaemonConfig } from "../core/daemon-config.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from "../core/defaults.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../core/extensions/index.ts";
import { IntegrationAccountStorage } from "../core/integration-account-storage.ts";
import { loadIntegrations } from "../core/integrations/loader.ts";
import { onboardIntegration } from "../core/integrations/onboarding.ts";
import type { Integration, IntegrationOnboardUI } from "../core/integrations/types.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { DefaultPluginManager } from "../core/plugin-manager.ts";
import { getServiceManager } from "../core/service/service-manager.ts";
import { SessionHost } from "../core/session-host.ts";
import { getDefaultModel, getDefaultProvider } from "../core/settings.ts";
import { type Theme, theme } from "../theme/theme.ts";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";
import {
	type DaemonCommand,
	type DaemonCommandType,
	type DaemonEvent,
	type DaemonResponse,
	type DaemonSessionState,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	FORWARDED_EVENT_TYPES,
	type OnboardServiceResult,
} from "./types.ts";

/** How many recent events the broadcaster keeps for `Last-Event-ID` replay. */
const RING_SIZE = 256;
/** Keepalive comment interval — without periodic traffic idle SSE connections drop. */
const KEEPALIVE_MS = 15_000;

/** `ok()` omits `data` entirely when undefined (async-ack commands carry no payload). */
function ok(id: string | undefined, command: DaemonCommandType, data?: unknown): DaemonResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true };
	}
	return { id, type: "response", command, success: true, data };
}

function err(id: string | undefined, command: string, message: string): DaemonResponse {
	return { id, type: "response", command, success: false, error: message };
}

/** A minimal deferred, used so `prompt` can ack acceptance without awaiting the whole turn. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** The `get_state` / `hello` snapshot — only the fields the host actually surfaces. */
function snapshot(host: SessionHost): DaemonSessionState {
	const harness = host.harness;
	return {
		model: harness.getModel(),
		thinkingLevel: harness.getThinkingLevel(),
		isStreaming: !harness.isIdle,
		sessionId: host.getSessionId(),
		sessionName: host.getSessionName(),
		sessionFile: host.getSessionFile(),
		messageCount: host.buildSessionContext().messages.length,
		pendingMessageCount: host.getPendingMessageCount(),
		config: host.config,
		cwd: host.getCwd(),
	};
}

/**
 * Drive `host.prompt()` and ack the instant the prompt is accepted (handled, queued, or
 * about to run) rather than when the whole turn ends — `host.prompt()` only resolves at
 * turn end. The turn itself streams over SSE; `agent_end` marks completion.
 */
async function handlePrompt(
	host: SessionHost,
	cmd: Extract<DaemonCommand, { type: "prompt" }>,
): Promise<DaemonResponse> {
	const accepted = deferred<void>();
	void host
		.prompt(cmd.message, {
			images: cmd.images,
			source: "rpc",
			streamingBehavior: cmd.streamingBehavior,
			preflightResult: (success) => {
				if (success) accepted.resolve();
			},
		})
		// A rejected prompt (e.g. an ambiguous mid-stream submit) throws its real error here; a
		// later turn-time failure is a no-op against the already-resolved deferred.
		.catch((e) => accepted.reject(e instanceof Error ? e : new Error(String(e))));
	await accepted.promise;
	return ok(cmd.id, "prompt");
}

/** Resolve the install root of a just-installed source (for plugin-scoped onboarding). */
function pluginRootForSpec(pluginManager: DefaultPluginManager, spec: string): string | undefined {
	// npm/git managed installs resolve cwd-independently; a local source resolves against the
	// daemon's cwd (the one writer runs server-side).
	const installed = pluginManager.getInstalledPath(spec);
	if (installed) return installed;
	const local = resolvePath(spec, process.cwd());
	return existsSync(local) ? local : undefined;
}

/**
 * Drive integration onboarding for the selected services, writing each credential through the host's
 * live account store (no cross-process staleness) and rendering `onboard(ctx)`'s dialogs via the
 * runner's bound `uiContext` (which emits them to attached clients). Returns structured per-service
 * results for the client to print.
 */
async function runDaemonOnboarding(
	host: SessionHost,
	selectServices: (input: { integrations: Integration[]; pluginManager: DefaultPluginManager }) => string[],
): Promise<OnboardServiceResult[]> {
	const name = host.config.name;
	const agentDir = getAgentDir(name);
	const { pluginManager } = createAgentPluginManager(name);
	const resolved = await pluginManager.resolve();
	const integrationPaths = resolved.integrations.filter((r) => r.enabled).map((r) => r.path);
	const { integrations } = await loadIntegrations(integrationPaths, agentDir);

	const services = selectServices({ integrations, pluginManager });
	// The host's live account store is the single writer; its bound uiContext renders dialogs over the wire.
	const accounts = host.integrationAccounts;
	const ui: IntegrationOnboardUI = host.extensionRunner.getUIContext();

	const results: OnboardServiceResult[] = [];
	for (const service of services) {
		const result = await onboardIntegration({ service, integrations, accounts, ui });
		results.push(
			result.status === "error"
				? { service, status: result.status, message: result.message }
				: { service, status: result.status },
		);
	}
	return results;
}

/**
 * The command dispatch switch. Throws on command-level failure (caught by the `/control`
 * route, surfaced as `err`).
 */
async function handleCommand(host: SessionHost, cmd: DaemonCommand): Promise<DaemonResponse> {
	const id = cmd.id;
	const harness = host.harness;

	switch (cmd.type) {
		// Prompting
		case "prompt":
			return handlePrompt(host, cmd);
		case "steer":
			await harness.steer(cmd.message, { images: cmd.images });
			return ok(id, "steer");
		case "follow_up":
			await harness.followUp(cmd.message, { images: cmd.images });
			return ok(id, "follow_up");
		case "abort":
			return ok(id, "abort", await harness.abort());
		case "compact":
			return ok(id, "compact", await harness.compact(cmd.customInstructions));
		case "wait_for_idle":
			await harness.waitForIdle();
			return ok(id, "wait_for_idle");
		case "clear_queue":
			return ok(id, "clear_queue", await host.clearQueue());
		case "new_session":
			// Return the fresh snapshot — never the harness the swap returns.
			await host.newSession({ reason: cmd.reason ?? "new" });
			return ok(id, "new_session", snapshot(host));
		case "reload":
			await host.reload();
			return ok(id, "reload");
		case "deploy": {
			// The human's single Yes. Flip the latch, register the OS service unit, and swap to a fresh
			// deployed session — persisted to disk, so the supervised daemon (which resumes the most-recent
			// session) picks up THIS fresh one. For a real backend, start the supervised daemon now: it
			// binds its own ephemeral port while this birth daemon keeps serving its own (two ephemeral
			// binds never collide). The client then reconnects to it and stops this daemon. With the `none`
			// backend there is no supervisor, so this daemon stays on the fresh session.
			const name = host.config.name;
			const serviceManager = getServiceManager();
			deployAgent(name);
			serviceManager.install(name);
			await host.newSession({ reason: "deploy" });
			if (serviceManager.kind !== "none") {
				serviceManager.start(name);
			}
			return ok(id, "deploy", snapshot(host));
		}

		// Model / thinking
		case "set_thinking_level":
			await harness.setThinkingLevel(cmd.level);
			return ok(id, "set_thinking_level");
		case "set_model":
			return ok(id, "set_model", await host.setModelById(cmd.provider, cmd.modelId));

		// State
		case "get_state":
			return ok(id, "get_state", snapshot(host));
		case "get_messages":
			return ok(id, "get_messages", { messages: host.buildSessionContext().messages });
		case "get_commands":
			return ok(id, "get_commands", { commands: host.getCommands() });
		case "get_entries":
			return ok(id, "get_entries", { entries: host.getEntries() });
		case "get_resource_summary":
			return ok(id, "get_resource_summary", host.getResourceSummary());

		// Session-mutation helpers
		case "seed_assistant_message":
			return ok(id, "seed_assistant_message", await host.seedAssistantMessage(cmd.text));
		case "append_message":
			await harness.appendMessage(cmd.message);
			return ok(id, "append_message");

		// Plugins — single-writer mutations: run the persist primitive in-process, then reload so
		// the daemon's own resources/accounts are never stale.
		case "install_plugin": {
			const { pluginManager } = createAgentPluginManager(host.config.name);
			await pluginManager.installAndPersist(cmd.source);
			await host.reload();
			return ok(id, "install_plugin");
		}
		case "remove_plugin": {
			const { pluginManager } = createAgentPluginManager(host.config.name);
			const removed = await pluginManager.removeAndPersist(cmd.source);
			await host.reload();
			return ok(id, "remove_plugin", { removed });
		}
		case "update_plugins": {
			const { pluginManager } = createAgentPluginManager(host.config.name);
			await pluginManager.update(cmd.source);
			await host.reload();
			return ok(id, "update_plugins");
		}
		// Onboarding writes through the host's live account store, so no second reload is needed
		// (the credential is already in-memory-consistent); `install_plugin` did the reload. The
		// source scopes onboarding to the just-installed plugin's integrations that declare `onboard`.
		case "onboard_plugin":
			return ok(id, "onboard_plugin", {
				results: await runDaemonOnboarding(host, ({ integrations, pluginManager }) => {
					const root = pluginRootForSpec(pluginManager, cmd.source);
					const services: string[] = [];
					for (const integration of integrations) {
						if (root && getCwdRelativePath(integration.resolvedPath, root) === undefined) continue;
						for (const [service, config] of integration.definitions) {
							if (config.onboard) services.push(service);
						}
					}
					return services;
				}),
			});

		default: {
			const unknown = cmd as { type: string };
			return err(undefined, unknown.type, `Unknown command: ${unknown.type}`);
		}
	}
}

/**
 * Resolve model/auth once and construct the `SessionHost` — the front half of the daemon runner.
 * Returns the unstarted `host` plus the `config` it was built from (the caller needs `config` for
 * the `fresh` decision), or an `{ error }` for the model/auth failures that should print to stderr
 * and exit 1.
 */
function createAgentSessionHost(
	name: string,
	opts: { provider?: string; model?: string; thinking?: ThinkingLevel },
): { host: SessionHost; config: AgentConfig } | { error: string } {
	const config = loadAgentConfig(name);

	const authStorage = AuthStorage.create();
	// Integration accounts are per-agent (`~/.steward/agents/<name>/integrations.json`).
	const integrationAccounts = IntegrationAccountStorage.create(name);
	const modelRegistry = ModelRegistry.create(authStorage);

	// Model precedence: --model flag → agent.json → shared default → built-in.
	const resolved = resolveCliModel({
		cliProvider: opts.provider,
		cliModel: opts.model ?? config.model ?? sharedDefaultModel() ?? DEFAULT_MODEL,
		cliThinking: opts.thinking,
		modelRegistry,
	});
	if (resolved.warning) {
		process.stderr.write(`${resolved.warning}\n`);
	}
	if (resolved.error || !resolved.model) {
		return { error: resolved.error ?? "Could not resolve a model." };
	}
	const model = resolved.model;

	// Auth precedence (handled by AuthStorage): runtime → auth.json (api key / OAuth)
	// → env var. hasAuth() doesn't refresh tokens — it just checks something exists.
	// If it returns false, every credential source (including the env var) is absent,
	// so the only actionable hint is to log in.
	if (!authStorage.hasAuth(model.provider)) {
		return { error: `No credentials found for provider "${model.provider}". Log in with the steward CLI.` };
	}

	const thinkingLevel = opts.thinking ?? resolved.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const host = new SessionHost({ name, model, thinkingLevel, authStorage, integrationAccounts });
	return { host, config };
}

export interface RunDaemonOptions {
	/** Manual bind-port override for this run (debugging); 0/absent → OS-assigned ephemeral. */
	port?: number;
	/** Start a fresh session — honored only once deployed (a forming agent stays in its birth session). */
	fresh?: boolean;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * The `daemon <name>` runner: start the agent's `SessionHost`, then wrap it in a long-running
 * HTTP/SSE server clients attach to. Binds an OS-assigned ephemeral port (unless `--port` overrides),
 * writes the pid/port/token to the temp-dir config so clients can find it, and blocks on the listening
 * server until a signal tears it down. The `@opsyhq/cli` client's hidden `daemon` subcommand and every
 * OS service unit invoke this.
 */
export async function runDaemon(name: string, opts: RunDaemonOptions = {}): Promise<number> {
	if (!agentExists(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}

	const built = createAgentSessionHost(name, opts);
	if ("error" in built) {
		process.stderr.write(`${built.error}\n`);
		return 1;
	}
	const { host, config } = built;

	// A forming agent stays in its single birth session; `fresh` only takes effect once deployed.
	const fresh = isDeployed(config) ? Boolean(opts.fresh) : false;
	await host.start({ fresh });

	// Every daemon binds an OS-assigned ephemeral port and writes it back to the temp config, where
	// clients discover it — no port is reserved up front. This is also what lets deploy stand up the
	// supervised daemon alongside the still-serving birth daemon: two ephemeral binds never collide.
	// `--port` is a manual override for this run (e.g. to pin a known port for debugging).
	const port = opts.port ?? 0;

	// Bearer token for /events + /control: the STEWARD_DAEMON_TOKEN override, else a fresh 256-bit hex.
	const token = process.env[ENV_DAEMON_TOKEN]?.trim() || randomBytes(32).toString("hex");
	saveDaemonConfig(name, {
		pid: process.pid,
		port,
		token,
		startedAt: new Date().toISOString(),
		version: VERSION,
	});

	const server = await runDaemonMode(host, { port, token });

	// serve()'s callback patched the config with the OS-assigned port once listening.
	const boundPort = loadDaemonConfig(name)?.port ?? port;
	console.log(`${APP_NAME} daemon for "${name}" listening on http://127.0.0.1:${boundPort}`);

	// server.close() drops the broadcaster subscription (via the server's "close" listener); we then
	// release the host + config.
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		await host.cleanup();
		// No deleteDaemonConfig here: the config is a health-validated discovery hint, and a deploy
		// handoff's supervised successor may already own it.
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	// The listening server keeps the event loop alive; block until a signal exits.
	return new Promise<number>(() => {});
}

/**
 * Bind a loopback HTTP/SSE server wrapping `host`, subscribe the broadcaster to the live harness
 * (re-subscribing after every swap), and resolve once it is listening. Returns the `serve()` server
 * so `runDaemon` can `server.close()` on shutdown — closing the server drops the broadcaster
 * subscription (via the `close` listener below), the leak `host.cleanup()` does not cover. Exported
 * for the daemon integration test, which drives it directly against a faux host; not part of the SDK
 * barrel.
 */
export async function runDaemonMode(
	host: SessionHost,
	{ port, token }: { port: number; token: string },
): Promise<ServerType> {
	const startedAt = new Date().toISOString();

	// ---- Event broadcaster ------------------------------------------------
	const clients = new Set<SSEStreamingApi>();
	let seq = 0;
	const ring: { id: number; frame: string }[] = [];

	const broadcast = async (event: AgentHarnessEvent): Promise<void> => {
		// Curation: forward only the allowlisted AgentEvent + queue/model/thinking updates;
		// drop the internal own-events (save_point, settled, abort, session_*, tools_update, …).
		if (!FORWARDED_EVENT_TYPES.has(event.type as DaemonEvent["type"])) return;
		seq += 1;
		const id = seq;
		const frame = JSON.stringify(event);
		ring.push({ id, frame });
		if (ring.length > RING_SIZE) ring.shift();
		for (const client of clients) {
			if (client.aborted) {
				clients.delete(client);
				continue;
			}
			await client.writeSSE({ id: String(id), event: "message", data: frame });
		}
	};

	// The extension-UI sink: fire-and-forget, no `seq`/ring, no SSE `id` — so a request frame is
	// not an AgentHarnessEvent and stays invisible to Last-Event-ID replay.
	const output = (request: ExtensionUIRequest): void => {
		for (const client of clients) {
			if (client.aborted) {
				clients.delete(client);
				continue;
			}
			void client.writeSSE({ event: "message", data: JSON.stringify(request) });
		}
	};

	// ---- Subscribe + rebind -----------------------------------------------
	// Keep exactly one subscription on the live harness: unsub-old → sub-new → store.
	let unsubscribe: (() => void) | undefined;
	const resubscribe = (harness: AgentHarness): void => {
		unsubscribe?.();
		unsubscribe = harness.subscribe(broadcast);
	};
	resubscribe(host.harness);
	// Re-fire after every harness swap (build/newSession) and after reload.
	host.setRebindHandler(resubscribe);

	// ---- Extension-UI bridge ----------------------------------------------
	// Swap the runner's noOpUIContext for one whose dialogs ride the SSE stream (via `output`) and
	// resolve over `POST /ui-response`. The four awaited dialogs (select/confirm/input/editor) park a
	// promise keyed by request id; the fire-and-forget methods just emit; the `theme` family is
	// data-only and unserializable surfaces are stubbed. `pendingExtensionRequests` is closure-scoped,
	// so it survives harness swaps: bindInteractiveContext re-applies the SAME uiContext to every
	// runner build()/reload(), so a fresh session never reverts to noOpUIContext and an in-flight
	// dialog survives a swap.
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: ExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	// Park a promise for an awaited dialog, with optional signal/timeout cancellation.
	const createDialogPromise = <T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: ExtensionUIResponse) => T,
	): Promise<T> => {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: ExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as ExtensionUIRequest);
		});
	};

	const uiContext: ExtensionUIContext = {
		select: (title, options, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise<boolean>(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget — no response needed.
			output({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
		},

		onTerminalInput(): () => void {
			// Raw terminal input is a client-only concern; the daemon has no terminal.
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			output({
				type: "extension_ui_request",
				id: randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			});
		},

		setWorkingMessage(_message?: string): void {
			// Requires TUI loader access — client-only.
		},

		setWorkingVisible(_visible: boolean): void {
			// Requires TUI loader access — client-only.
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Requires TUI loader access — client-only.
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Requires TUI message rendering — client-only.
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only string arrays cross the wire; component factories can't be serialized.
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer is a component factory — can't serialize.
		},

		setHeader(_factory: unknown): void {
			// Custom header is a component factory — can't serialize.
		},

		setTitle(title: string): void {
			output({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
		},

		async custom() {
			// Custom components can't cross the wire.
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// No paste semantics over the wire — falls back to setEditorText.
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			output({ type: "extension_ui_request", id: randomUUID(), method: "setEditorText", text });
		},

		getEditorText(): string {
			// Synchronous read can't round-trip; the client tracks editor state locally.
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			// Parked directly — `editor` has no signal/timeout in the extension API, so the
			// last-client-gone cancel below is its only escape from hanging forever.
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: ExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) resolve(undefined);
						else if ("value" in response) resolve(response.value);
						else resolve(undefined);
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill });
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete composition is a client-only concern.
		},

		setEditorComponent(): void {
			// Custom editor components can't be serialized.
		},

		getEditorComponent() {
			return undefined;
		},

		// —— theme family: data-only / inert (theme rendering is a client concern) ——
		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			return { success: false, error: "UI not available" };
		},

		getToolsExpanded() {
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion is client TUI state.
		},
	};

	host.bindInteractiveContext({
		uiContext,
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => host.harness.waitForIdle(),
			newSession: async () => {
				await host.newSession({ reason: "new" });
				return { cancelled: false };
			},
			// Tree navigation is not a daemon concern — report cancelled.
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: () => host.reload(),
		},
	});

	// ---- HTTP app ---------------------------------------------------------
	const app = new Hono();
	app.use("/events", bearerAuth({ token }));
	app.use("/control", bearerAuth({ token }));
	app.use("/ui-response", bearerAuth({ token }));

	app.get("/health", (c) => c.json({ status: "ok", agent: host.config.name, pid: process.pid, startedAt }));

	app.get("/events", (c) =>
		streamSSE(c, async (stream) => {
			clients.add(stream);
			// Capture the replay watermark with NO intervening await, so live broadcasts
			// (id > watermark) and replayed events (id ≤ watermark) stay disjoint — no
			// double-delivery across the reconnect boundary.
			const replayUpTo = seq;
			stream.onAbort(() => {
				clients.delete(stream);
				// With no client left to answer, resolve every parked dialog to cancel — otherwise a
				// dialog open when its owning client dropped (notably `editor`, which has no
				// signal/timeout) would hang forever. Other clients still attached keep dialogs parked.
				if (clients.size === 0) {
					for (const [id, pending] of [...pendingExtensionRequests]) {
						pending.resolve({ type: "extension_ui_response", id, cancelled: true });
					}
					pendingExtensionRequests.clear();
				}
			});

			// Replay buffered events after the client's Last-Event-ID, bounded by the watermark.
			const lastEventId = c.req.header("Last-Event-ID");
			if (lastEventId !== undefined) {
				const after = Number(lastEventId);
				for (const entry of ring) {
					if (entry.id > after && entry.id <= replayUpTo) {
						await stream.writeSSE({ id: String(entry.id), event: "message", data: entry.frame });
					}
				}
			}

			// hello = the get_state snapshot, so a fresh attach knows the current state at once.
			await stream.writeSSE({ event: "hello", data: JSON.stringify(snapshot(host)) });

			// Mandatory keepalive: Hono closes the stream when this callback returns, so the
			// loop must run for the connection's lifetime (Hono issue #2993). The heartbeat
			// is a raw SSE comment via stream.write (not writeSSE).
			while (!stream.aborted) {
				await stream.sleep(KEEPALIVE_MS);
				if (stream.aborted) break;
				await stream.write(": ping\n\n");
			}
		}),
	);

	app.post("/control", async (c) => {
		// Parse inside the try so a malformed body becomes a structured {success:false} error
		// instead of an unstructured HTTP 500.
		let cmd: DaemonCommand;
		try {
			cmd = await c.req.json<DaemonCommand>();
		} catch {
			return c.json(err(undefined, "unknown", "Malformed JSON body."));
		}
		try {
			return c.json(await handleCommand(host, cmd));
		} catch (e) {
			return c.json(err(cmd.id, cmd.type, e instanceof Error ? e.message : String(e)));
		}
	});

	// A client's answer to an awaited extension-UI dialog — resolve the parked promise by id.
	app.post("/ui-response", async (c) => {
		let response: ExtensionUIResponse;
		try {
			response = await c.req.json<ExtensionUIResponse>();
		} catch {
			return c.json({ success: false, error: "Malformed JSON body." });
		}
		const pending = pendingExtensionRequests.get(response.id);
		if (pending) {
			pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
		}
		return c.json({ success: true });
	});

	// ---- Serve ------------------------------------------------------------
	// Patch the resolved port back into the config — for `port: 0` the real port is only
	// known once the OS assigns it (read off serve()'s `info.port`).
	const writePortBack = (port: number): void => {
		const existing = loadDaemonConfig(host.config.name);
		if (existing) saveDaemonConfig(host.config.name, { ...existing, port });
	};

	const server = await new Promise<ServerType>((resolve) => {
		const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
			writePortBack(info.port);
			resolve(s);
		});
	});

	// host.cleanup() does NOT drop the broadcaster subscription, so tie it to server close.
	server.on("close", () => {
		try {
			unsubscribe?.();
		} catch {
			/* harness already gone with its subscription */
		}
	});

	return server;
}

/**
 * The shared default model as a `provider/model` reference (or just the model
 * id when no provider is set), read from `~/.steward/agent/settings.json`. Used
 * to seed model resolution when neither `--model` nor agent.json picks a model.
 */
function sharedDefaultModel(): string | undefined {
	const model = getDefaultModel();
	if (!model) return undefined;
	const provider = getDefaultProvider();
	return provider ? `${provider}/${model}` : model;
}
