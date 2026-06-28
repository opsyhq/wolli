/**
 * Daemon server + runner.
 *
 * `runDaemon(name, opts)` resolves the agent's model/auth, starts its `AgentRuntime`, then binds a
 * long-running loopback HTTP/SSE server around it and blocks until a signal tears it down. The wire is
 * session-namespaced:
 *
 *   - `GET /events`              (SSE) — the root control stream: agent snapshot + session lifecycle;
 *   - `GET /sessions`                  — the session list;
 *   - `GET /sessions/:id/events` (SSE) — one session's curated event stream (subscribing makes it live);
 *   - `POST /sessions/:id/control`     — a command for that session, whose sync response is the body;
 *   - `POST /sessions/:id/ui-response` — a client's answer to that session's parked extension dialog;
 *   - `POST /sessions/:id/login-response` — a client's answer to that session's parked login dialog;
 *   - `GET /health`                    — liveness, no auth.
 *
 * `AgentRuntime` owns every lifecycle concern (start/create/open/close/reload/cleanup); the server is a
 * thin wrapper that calls into it. The `@opsyhq/cli` client's hidden `daemon` subcommand and every OS
 * service unit invoke `runDaemon`.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ServerType, serve } from "@hono/node-server";
import type { AgentHarnessEvent } from "@opsyhq/agent";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { APP_NAME, getAgentAuthPath, getAgentDir, getDaemonHost, getDaemonToken } from "./config.ts";
import { createAgentPluginManager } from "./core/agent-plugin-manager.ts";
import { AgentRuntime, type AgentSession } from "./core/agent-runtime.ts";
import { AgentSettingsManager } from "./core/agent-settings-manager.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "./core/extensions/index.ts";
import { IntegrationAccountStorage } from "./core/integration-account-storage.ts";
import { IntegrationStore } from "./core/integration-store.ts";
import { loadIntegrations } from "./core/integrations/loader.ts";
import { onboardIntegration } from "./core/integrations/onboarding.ts";
import type { Integration, IntegrationOnboardUI } from "./core/integrations/types.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import { findInitialModel } from "./core/model-resolver.ts";
import type { DefaultPluginManager } from "./core/plugin-manager.ts";
import { getServiceManager } from "./core/service/service-manager.ts";
import { type Theme, theme } from "./theme/theme.ts";
import {
	type DaemonAgentState,
	type DaemonCommand,
	type DaemonCommandType,
	type DaemonControlEvent,
	type DaemonEvent,
	type DaemonResponse,
	type DaemonSessionState,
	type DaemonSessionSummary,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	FORWARDED_EVENT_TYPES,
	type LoginUIRequest,
	type LoginUIResponse,
	type OnboardServiceResult,
	type ScopedModelsUpdateEvent,
} from "./types.ts";
import { getCwdRelativePath, resolvePath } from "./utils/paths.ts";

/** How many recent events each session's broadcaster keeps for `Last-Event-ID` replay. */
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

/** One session's summary for the list / lifecycle frames. */
function sessionSummary(session: AgentSession): DaemonSessionSummary {
	return {
		sessionId: session.getSessionId(),
		sessionName: session.getSessionName(),
		isStreaming: session.isStreaming(),
		live: true,
	};
}

/** The per-session `get_state` / session-stream `hello` snapshot. */
function sessionSnapshot(session: AgentSession): DaemonSessionState {
	const harness = session.harness;
	return {
		sessionId: session.getSessionId(),
		model: harness.getModel(),
		thinkingLevel: harness.getThinkingLevel(),
		scopedModels: session.getScopedModels(),
		isStreaming: !harness.isIdle,
		sessionName: session.getSessionName(),
		sessionFile: session.getSessionFile(),
		messageCount: session.buildSessionContext().messages.length,
		pendingMessageCount: session.getPendingMessageCount(),
	};
}

/** The agent-global snapshot — config/cwd plus the merged (durable + resident) session list. */
async function agentSnapshot(runtime: AgentRuntime): Promise<DaemonAgentState> {
	const durable = await runtime.listSessions();
	const sessions: DaemonSessionSummary[] = durable.map((info) => {
		const live = runtime.getSession(info.id);
		return {
			sessionId: info.id,
			sessionName: live?.getSessionName(),
			createdAt: info.createdAt,
			isStreaming: live ? live.isStreaming() : false,
			live: !!live,
		};
	});
	return { config: runtime.config, cwd: runtime.getCwd(), sessions };
}

/**
 * Drive a session's `prompt()` and ack the instant the prompt is accepted (handled, queued, or about
 * to run) rather than when the whole turn ends — `prompt()` only resolves at turn end. The turn itself
 * streams over the session's SSE; `agent_end` marks completion.
 */
async function handlePrompt(
	session: AgentSession,
	cmd: Extract<DaemonCommand, { type: "prompt" }>,
): Promise<DaemonResponse> {
	const accepted = deferred<void>();
	void session
		.prompt(cmd.message, {
			images: cmd.images,
			source: "rpc",
			streamingBehavior: cmd.streamingBehavior,
			preflightResult: (success) => {
				if (success) accepted.resolve();
			},
		})
		// A rejected prompt (e.g. an ambiguous mid-stream submit) throws its real error here; a later
		// turn-time failure is a no-op against the already-resolved deferred.
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
 * Drive integration onboarding for the selected services, writing each credential through the runtime's
 * live account store (no cross-process staleness) and rendering `onboard(ctx)`'s dialogs via the
 * initiating session's `ui` (which emits them to that session's clients). Returns structured per-service
 * results for the client to print.
 */
async function runDaemonOnboarding(
	runtime: AgentRuntime,
	ui: ExtensionUIContext,
	selectServices: (input: { integrations: Integration[]; pluginManager: DefaultPluginManager }) => string[],
): Promise<OnboardServiceResult[]> {
	const name = runtime.config.name;
	const agentDir = getAgentDir(name);
	const { pluginManager } = createAgentPluginManager(name);
	const resolved = await pluginManager.resolve();
	const integrationPaths = resolved.integrations.filter((r) => r.enabled).map((r) => r.path);
	const { integrations } = await loadIntegrations(integrationPaths, agentDir);

	const services = selectServices({ integrations, pluginManager });
	// The runtime's live account store is the single writer; the initiating session's ui renders dialogs.
	const accounts = runtime.integrationAccounts;
	const onboardUI: IntegrationOnboardUI = ui;

	const results: OnboardServiceResult[] = [];
	for (const service of services) {
		const result = await onboardIntegration({ service, integrations, accounts, ui: onboardUI });
		results.push(
			result.status === "error"
				? { service, status: result.status, message: result.message }
				: { service, status: result.status },
		);
	}
	return results;
}

/**
 * The command dispatch switch. `session` is the session named in the URL path — the target for session-
 * scoped verbs, and the UI rail for agent-global verbs (login/reload/…) whose effect is global but whose
 * dialogs route back to the initiating session. Throws on command-level failure (caught by the route).
 */
async function handleCommand(
	runtime: AgentRuntime,
	session: AgentSession,
	cmd: DaemonCommand,
	requestShutdown: () => void,
): Promise<DaemonResponse> {
	const id = cmd.id;
	const harness = session.harness;

	switch (cmd.type) {
		// Prompting
		case "prompt":
			return handlePrompt(session, cmd);
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
		case "abort_compaction":
			harness.abortCompaction();
			return ok(id, "abort_compaction");
		case "wait_for_idle":
			await harness.waitForIdle();
			return ok(id, "wait_for_idle");
		case "clear_queue":
			return ok(id, "clear_queue", await session.clearQueue());
		case "create_session": {
			// Additive: a fresh session alongside the rest. A forming agent stays in its birth session.
			if (!AgentSettingsManager.create(runtime.config.name).getAgentDeployed()) {
				throw new Error("This agent is still forming — it stays in its birth session until it deploys.");
			}
			const created = await runtime.createSession();
			return ok(id, "create_session", sessionSnapshot(created));
		}
		case "reload":
			await runtime.reload();
			return ok(id, "reload");
		case "deploy": {
			// The human's single Yes: flip the latch, enable the OS unit, and create a fresh deployed
			// session (persisted, so the restarted daemon resumes it). The client drives the stop-then-start
			// handoff on the fixed port; with the `none` backend this daemon just stays on the fresh session.
			const name = runtime.config.name;
			AgentSettingsManager.create(name).setAgentDeployed();
			getServiceManager().install(name);
			const deployed = await runtime.createSession();
			return ok(id, "deploy", sessionSnapshot(deployed));
		}
		case "shutdown":
			// Ack first; self-exit on a microtask so the response flushes before the listener closes.
			queueMicrotask(() => requestShutdown());
			return ok(id, "shutdown");

		// Model / thinking
		case "set_thinking_level":
			await session.setThinkingLevel(cmd.level);
			return ok(id, "set_thinking_level");
		case "set_model":
			return ok(id, "set_model", await session.setModelById(cmd.provider, cmd.modelId));
		case "get_available_models":
			return ok(id, "get_available_models", { models: runtime.getAvailableModels() });
		case "set_scoped_models":
			await session.setScopedModels(cmd.enabledModelIds);
			return ok(id, "set_scoped_models");
		case "set_enabled_models":
			runtime.setEnabledModels(cmd.enabledModels);
			return ok(id, "set_enabled_models");

		// Provider login — runs daemon-side; the browser opens client-side and the prompts/selects ride
		// the session's login seam. A per-session AbortController lets `login_cancel` abort a hung flow.
		case "login": {
			const ac = new AbortController();
			session.loginAbortController = ac;
			try {
				return ok(
					id,
					"login",
					await runtime.login(cmd.provider, cmd.authType, session.createLoginCallbacks(ac.signal)),
				);
			} finally {
				session.loginAbortController = undefined;
			}
		}
		case "login_cancel":
			session.loginAbortController?.abort();
			return ok(id, "login_cancel");
		case "logout":
			return ok(id, "logout", runtime.logout(cmd.provider));
		case "get_login_providers":
			return ok(id, "get_login_providers", { providers: runtime.getLoginProviderOptions(cmd.authType) });
		case "get_logout_providers":
			return ok(id, "get_logout_providers", { providers: runtime.getLogoutProviderOptions() });

		// State
		case "get_state":
			return ok(id, "get_state", sessionSnapshot(session));
		case "get_messages":
			return ok(id, "get_messages", { messages: session.buildSessionContext().messages });
		case "get_commands":
			return ok(id, "get_commands", { commands: runtime.getCommands() });
		case "get_entries":
			return ok(id, "get_entries", { entries: session.getEntries() });
		case "get_resource_summary":
			return ok(id, "get_resource_summary", runtime.getResourceSummary());
		case "get_tool_info":
			return ok(id, "get_tool_info", {
				tools: runtime.getToolInfos(harness),
				activeToolNames: harness.getActiveTools().map((tool) => tool.name),
			});
		case "get_integration_info":
			return ok(id, "get_integration_info", { integrations: runtime.getIntegrationInfos() });
		case "get_skills":
			return ok(id, "get_skills", { skills: runtime.getSkills() });
		case "get_plugins":
			return ok(id, "get_plugins", { plugins: runtime.getPlugins() });
		case "get_context_info":
			return ok(id, "get_context_info", { contexts: runtime.getContextInfos() });

		// Session-mutation helpers
		case "seed_assistant_message":
			return ok(id, "seed_assistant_message", await session.seedAssistantMessage(cmd.text));
		case "append_message":
			await harness.appendMessage(cmd.message);
			return ok(id, "append_message");

		// Plugins — single-writer mutations: run the persist primitive in-process, then reload so
		// the daemon's own resources/accounts are never stale.
		case "install_plugin": {
			const { pluginManager } = createAgentPluginManager(runtime.config.name);
			await pluginManager.installAndPersist(cmd.source);
			await runtime.reload();
			return ok(id, "install_plugin");
		}
		case "remove_plugin": {
			const { pluginManager } = createAgentPluginManager(runtime.config.name);
			const removed = await pluginManager.removeAndPersist(cmd.source);
			await runtime.reload();
			return ok(id, "remove_plugin", { removed });
		}
		case "update_plugins": {
			const { pluginManager } = createAgentPluginManager(runtime.config.name);
			await pluginManager.update(cmd.source);
			await runtime.reload();
			return ok(id, "update_plugins");
		}
		// Onboarding writes through the runtime's live account store, so no second reload is needed; the
		// source scopes onboarding to the just-installed plugin's integrations that declare `onboard`.
		case "onboard_plugin":
			return ok(id, "onboard_plugin", {
				results: await runDaemonOnboarding(runtime, session.ui, ({ integrations, pluginManager }) => {
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
 * Resolve the model and construct the (unstarted) `AgentRuntime` — the front half of the daemon runner.
 * A missing/unauth'd model is not fatal: the runtime starts model-less and the request-time auth check
 * surfaces the clean "log in" error on the first turn, so the daemon always comes up.
 */
async function createAgentRuntime(name: string): Promise<AgentRuntime> {
	const store = AgentSettingsManager.create(name);

	// Per-agent credentials override the shared store per provider: the agent tier
	// (`~/.wolli/agents/<name>/auth.json`) defers to the global tier on a per-provider miss.
	const globalAuth = AuthStorage.create();
	const authStorage = AuthStorage.create(getAgentAuthPath(name), globalAuth);
	// Integration accounts are per-agent (`~/.wolli/agents/<name>/integrations.json`).
	const integrationAccounts = IntegrationAccountStorage.create(name);
	// Integration runtime state is per-agent, one file per service (`~/.wolli/agents/<name>/store/`).
	const integrationStore = IntegrationStore.create(name);
	const modelRegistry = ModelRegistry.create(authStorage);

	// Model precedence: agent.json override → shared default → known-provider defaults → first-available.
	const savedModel = store.getDefaultModel();
	const slashIndex = savedModel?.indexOf("/") ?? -1;
	const defaultProvider = savedModel && slashIndex !== -1 ? savedModel.slice(0, slashIndex) : undefined;
	const defaultModelId = savedModel ? (slashIndex !== -1 ? savedModel.slice(slashIndex + 1) : savedModel) : undefined;
	const resolved = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider,
		defaultModelId,
		modelRegistry,
	});
	// No auth'd model is not fatal: the runtime starts model-less (the engine falls back to a concrete
	// default so it always holds a model) and the request-time auth check surfaces the clean "log in"
	// error on the first turn. Login then happens inline via /login + /model.
	return new AgentRuntime({
		name,
		model: resolved.model,
		authStorage,
		modelRegistry,
		integrationAccounts,
		integrationStore,
	});
}

export interface RunDaemonOptions {
	/** Manual bind-port override for this run (debugging); absent → the fixed port from agent.json. */
	port?: number;
}

/**
 * The `daemon <name>` runner: start the agent's `AgentRuntime`, then wrap it in a long-running HTTP/SSE
 * server clients attach to. Binds the agent's fixed host/port (from agent.json, allocated at creation;
 * `WOLLI_DAEMON_HOST` and `--port` override) and blocks on the listening server until a signal — or a
 * `shutdown` command — tears it down. The `@opsyhq/cli` client's hidden `daemon` subcommand and every OS
 * service unit invoke this.
 */
export async function runDaemon(name: string, opts: RunDaemonOptions = {}): Promise<number> {
	const store = AgentSettingsManager.get(name);
	if (!store) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}

	const runtime = await createAgentRuntime(name);

	// Fixed per-agent port + token from agent.json; `--port` and WOLLI_DAEMON_TOKEN override.
	const port = opts.port ?? store.config.port;
	const token = getDaemonToken() || store.config.token;

	let server: ServerType | undefined;
	let shuttingDown = false;
	const shutdown = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server?.close();
		await runtime.cleanup();
		process.exit(exitCode);
	};

	server = await runDaemonMode(runtime, { port, token, requestShutdown: () => void shutdown(0) });

	console.log(`${APP_NAME} daemon for "${name}" listening on http://${getDaemonHost()}:${port}`);

	process.on("SIGTERM", () => void shutdown(143));
	process.on("SIGINT", () => void shutdown(130));

	// The listening server keeps the event loop alive; block until a signal/shutdown exits.
	return new Promise<number>(() => {});
}

/**
 * Bind a loopback HTTP/SSE server wrapping `runtime`: build the per-session UI rails, start the runtime,
 * open the initial session, then serve the session-namespaced routes. Resolves once it is listening.
 * Returns the `serve()` server so `runDaemon` can `server.close()` on shutdown. Exported for the daemon
 * integration test, which drives it directly; not part of the SDK barrel.
 */
export async function runDaemonMode(
	runtime: AgentRuntime,
	{ port, token, requestShutdown }: { port: number; token: string; requestShutdown: () => void },
): Promise<ServerType> {
	const startedAt = new Date().toISOString();

	// ---- Per-session event broadcaster ------------------------------------
	// Each session owns its own subscriber set, sequence counter, and replay ring (the path scopes its
	// stream, so frames need no session id). A session goes live when its first client attaches and is
	// dropped when its last detaches (if idle); the harness subscription tracks that window.
	const sessionClients = new Map<string, Set<SSEStreamingApi>>();
	const sessionSeq = new Map<string, number>();
	const sessionRing = new Map<string, { id: number; frame: string }[]>();
	const sessionUnsub = new Map<string, () => void>();
	// Each session's parked extension-UI dialogs, keyed by request id within the session.
	const sessionPending = new Map<
		string,
		Map<string, { resolve: (r: ExtensionUIResponse) => void; reject: (e: Error) => void }>
	>();
	// Each session's parked login dialogs, keyed by request id (the login seam's analogue of sessionPending).
	const loginPending = new Map<
		string,
		Map<string, { resolve: (r: LoginUIResponse) => void; reject: (e: Error) => void }>
	>();
	// The root control-stream subscribers (agent snapshot + session lifecycle).
	const controlClients = new Set<SSEStreamingApi>();

	const broadcastToSession = async (
		sessionId: string,
		event: AgentHarnessEvent | ScopedModelsUpdateEvent,
	): Promise<void> => {
		// Curation: forward only the allowlisted AgentEvent + queue/model/thinking updates; drop the
		// internal own-events (save_point, settled, abort, session_*, tools_update, …).
		if (!FORWARDED_EVENT_TYPES.has(event.type as DaemonEvent["type"])) return;
		const clients = sessionClients.get(sessionId);
		if (!clients || clients.size === 0) return;
		const seq = (sessionSeq.get(sessionId) ?? 0) + 1;
		sessionSeq.set(sessionId, seq);
		const frame = JSON.stringify(event);
		const ring = sessionRing.get(sessionId) ?? [];
		ring.push({ id: seq, frame });
		if (ring.length > RING_SIZE) ring.shift();
		sessionRing.set(sessionId, ring);
		for (const client of clients) {
			if (client.aborted) {
				clients.delete(client);
				continue;
			}
			await client.writeSSE({ id: String(seq), event: "message", data: frame });
		}
	};

	const broadcastControl = (event: DaemonControlEvent): void => {
		const frame = JSON.stringify(event);
		for (const client of controlClients) {
			if (client.aborted) {
				controlClients.delete(client);
				continue;
			}
			void client.writeSSE({ event: "message", data: frame });
		}
	};

	// Subscribe the broadcaster to a session's harness while it has clients (exactly once per session).
	const subscribeSession = (session: AgentSession): void => {
		const sessionId = session.getSessionId();
		if (sessionUnsub.has(sessionId)) return;
		sessionUnsub.set(
			sessionId,
			session.harness.subscribe((event) => void broadcastToSession(sessionId, event)),
		);
	};
	const unsubscribeSession = (sessionId: string): void => {
		sessionUnsub.get(sessionId)?.();
		sessionUnsub.delete(sessionId);
	};

	// The extension-UI / login sink for one session: fire-and-forget, no `seq`/ring/SSE `id` — so a
	// request frame is not an AgentHarnessEvent and stays invisible to Last-Event-ID replay.
	const output = (sessionId: string, request: ExtensionUIRequest | LoginUIRequest): void => {
		const clients = sessionClients.get(sessionId);
		if (!clients) return;
		for (const client of clients) {
			if (client.aborted) {
				clients.delete(client);
				continue;
			}
			void client.writeSSE({ event: "message", data: JSON.stringify(request) });
		}
	};

	/**
	 * Build the per-session UI rail bound to `sessionId`: its four awaited dialogs (select/confirm/
	 * input/editor) park a promise in the session's pending map and emit a request frame to the
	 * session's clients; the fire-and-forget methods just emit; unserializable surfaces are stubbed.
	 */
	const createSessionUI = (sessionId: string): ExtensionUIContext => {
		const pending = (): Map<string, { resolve: (r: ExtensionUIResponse) => void; reject: (e: Error) => void }> => {
			let map = sessionPending.get(sessionId);
			if (!map) {
				map = new Map();
				sessionPending.set(sessionId, map);
			}
			return map;
		};

		// Park a promise for an awaited dialog, with optional signal/timeout cancellation.
		const createDialogPromise = <T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: ExtensionUIResponse) => T,
		): Promise<T> => {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const requestId = randomUUID();
			return new Promise((resolve, reject) => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;

				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					opts?.signal?.removeEventListener("abort", onAbort);
					pending().delete(requestId);
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

				pending().set(requestId, {
					resolve: (response: ExtensionUIResponse) => {
						cleanup();
						resolve(parseResponse(response));
					},
					reject,
				});
				output(sessionId, { type: "extension_ui_request", id: requestId, ...request } as ExtensionUIRequest);
			});
		};

		const ui: ExtensionUIContext = {
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
				output(sessionId, {
					type: "extension_ui_request",
					id: randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				});
			},

			onTerminalInput(): () => void {
				// Raw terminal input is a client-only concern; the daemon has no terminal.
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				output(sessionId, {
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
					output(sessionId, {
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
				output(sessionId, { type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
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
				output(sessionId, { type: "extension_ui_request", id: randomUUID(), method: "setEditorText", text });
			},

			getEditorText(): string {
				// Synchronous read can't round-trip; the client tracks editor state locally.
				return "";
			},

			async editor(title: string, prefill?: string): Promise<string | undefined> {
				// Parked directly — `editor` has no signal/timeout in the extension API, so the
				// last-client-gone cancel below is its only escape from hanging forever.
				const requestId = randomUUID();
				return new Promise((resolve, reject) => {
					pending().set(requestId, {
						resolve: (response: ExtensionUIResponse) => {
							if ("cancelled" in response && response.cancelled) resolve(undefined);
							else if ("value" in response) resolve(response.value);
							else resolve(undefined);
						},
						reject,
					});
					output(sessionId, { type: "extension_ui_request", id: requestId, method: "editor", title, prefill });
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
		return ui;
	};

	/**
	 * Build the per-session login callbacks bound to `sessionId`, driven by `signal` (the `login_cancel`
	 * command aborts it). Mirrors `createSessionUI`: `auth`/`deviceCode`/`progress` are fire-and-forget
	 * frames; `prompt`/`manualInput`/`select` park a promise in the session's `loginPending` map and emit
	 * a request frame the client answers via `POST /sessions/:id/login-response`.
	 */
	const createLoginCallbacks = (sessionId: string, signal: AbortSignal): OAuthLoginCallbacks => {
		const pending = (): Map<string, { resolve: (r: LoginUIResponse) => void; reject: (e: Error) => void }> => {
			let map = loginPending.get(sessionId);
			if (!map) {
				map = new Map();
				loginPending.set(sessionId, map);
			}
			return map;
		};

		// Park a promise for an awaited login dialog; resolve to `defaultValue` if the login is cancelled
		// (the signal aborts) before the client answers, so the provider flow never hangs.
		const park = <T>(
			request: Record<string, unknown>,
			defaultValue: T,
			parseResponse: (response: LoginUIResponse) => T,
		): Promise<T> => {
			if (signal.aborted) return Promise.resolve(defaultValue);
			const requestId = randomUUID();
			return new Promise((resolve, reject) => {
				const cleanup = () => {
					signal.removeEventListener("abort", onAbort);
					pending().delete(requestId);
				};
				const onAbort = () => {
					cleanup();
					resolve(defaultValue);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending().set(requestId, {
					resolve: (response: LoginUIResponse) => {
						cleanup();
						resolve(parseResponse(response));
					},
					reject,
				});
				output(sessionId, { type: "login_ui_request", id: requestId, ...request } as LoginUIRequest);
			});
		};

		const emit = (request: Record<string, unknown>): void => {
			output(sessionId, { type: "login_ui_request", id: randomUUID(), ...request } as LoginUIRequest);
		};

		return {
			onAuth: (info) => emit({ method: "auth", url: info.url, instructions: info.instructions }),
			onDeviceCode: (info) =>
				emit({ method: "deviceCode", userCode: info.userCode, verificationUri: info.verificationUri }),
			onProgress: (message) => emit({ method: "progress", message }),
			onPrompt: (prompt) =>
				park({ method: "prompt", message: prompt.message, placeholder: prompt.placeholder }, "", (r) =>
					"cancelled" in r ? "" : r.value,
				),
			onManualCodeInput: () => park({ method: "manualInput" }, "", (r) => ("cancelled" in r ? "" : r.value)),
			onSelect: (prompt) =>
				park<string | undefined>(
					{ method: "select", message: prompt.message, options: prompt.options },
					undefined,
					(r) => ("cancelled" in r ? undefined : r.value),
				),
			signal,
		};
	};

	// ---- Bind the runtime host surface + lifecycle bridges -----------------
	runtime.bindInteractiveContext({
		createSessionUI,
		createLoginCallbacks,
		mode: "rpc",
		// Runner errors (extension + integration) are agent-global — no originating session — so notify
		// every live session's clients.
		onError: (e) => {
			for (const session of runtime.listLiveSessions()) session.ui.notify(`${e.path}: ${e.error}`, "error");
		},
		newSession: async () => {
			if (!AgentSettingsManager.create(runtime.config.name).getAgentDeployed()) {
				throw new Error("This agent is still forming — it stays in its birth session until it deploys.");
			}
			await runtime.createSession();
			return { cancelled: false };
		},
	});
	// Session lifecycle → control stream, so a client tracking the open-session list keeps it fresh.
	runtime.setSessionLifecycleHandler((event) => {
		if (event.type === "added") broadcastControl({ type: "session_added", session: sessionSummary(event.session) });
		else if (event.type === "removed") broadcastControl({ type: "session_removed", sessionId: event.sessionId });
		else broadcastControl({ type: "session_renamed", sessionId: event.sessionId, sessionName: event.sessionName });
	});
	// Scoped-model scope changes are runtime-originated (not harness own-events) — bridge each onto the
	// owning session's broadcaster.
	runtime.setScopedModelsHandler(
		(sessionId, scopedModels) => void broadcastToSession(sessionId, { type: "scoped_models_update", scopedModels }),
	);

	// Build the agent-global shared resources, then open the initial (most-recent or fresh) session so
	// the agent always has at least one session to list/attach.
	await runtime.start();
	await runtime.openSession();

	// ---- HTTP app ---------------------------------------------------------
	const app = new Hono();
	app.use("/events", bearerAuth({ token }));
	app.use("/sessions", bearerAuth({ token }));
	app.use("/sessions/*", bearerAuth({ token }));

	app.get("/health", (c) => c.json({ status: "ok", agent: runtime.config.name, pid: process.pid, startedAt }));

	// Root control stream: agent snapshot hello + session lifecycle frames.
	app.get("/events", (c) =>
		streamSSE(c, async (stream) => {
			controlClients.add(stream);
			stream.onAbort(() => {
				controlClients.delete(stream);
			});
			await stream.writeSSE({ event: "hello", data: JSON.stringify(await agentSnapshot(runtime)) });
			while (!stream.aborted) {
				await stream.sleep(KEEPALIVE_MS);
				if (stream.aborted) break;
				await stream.write(": ping\n\n");
			}
		}),
	);

	// The session list.
	app.get("/sessions", async (c) => c.json(await agentSnapshot(runtime)));

	// Per-session event stream. Subscribing makes the session live (rehydrating it if idle); the last
	// client detaching evicts it (when idle).
	app.get("/sessions/:id/events", (c) =>
		streamSSE(c, async (stream) => {
			const id = c.req.param("id");
			let session: AgentSession;
			try {
				session = runtime.getSession(id) ?? (await runtime.openSession(id));
			} catch {
				await stream.writeSSE({ event: "error", data: `No session "${id}"` });
				return;
			}

			let clients = sessionClients.get(id);
			if (!clients) {
				clients = new Set();
				sessionClients.set(id, clients);
			}
			const firstClient = clients.size === 0;
			clients.add(stream);
			if (firstClient) subscribeSession(session);

			// Capture the replay watermark with NO intervening await, so live broadcasts (id > watermark)
			// and replayed events (id ≤ watermark) stay disjoint — no double-delivery across reconnect.
			const replayUpTo = sessionSeq.get(id) ?? 0;
			stream.onAbort(() => {
				clients.delete(stream);
				if (clients.size === 0) {
					// No client left to answer this session's parked dialogs — resolve them to cancel
					// (notably `editor`, which has no signal/timeout, would otherwise hang forever).
					const pending = sessionPending.get(id);
					if (pending) {
						for (const [requestId, p] of [...pending]) {
							p.resolve({ type: "extension_ui_response", id: requestId, cancelled: true });
						}
						pending.clear();
					}
					// Same for any parked login dialogs — drain them as cancelled so the login flow unwinds.
					const pendingLogin = loginPending.get(id);
					if (pendingLogin) {
						for (const [requestId, p] of [...pendingLogin]) {
							p.resolve({ type: "login_ui_response", id: requestId, cancelled: true });
						}
						pendingLogin.clear();
					}
					unsubscribeSession(id);
					// Driver gone — evict the session unless a turn is still in flight (never kill a turn).
					const live = runtime.getSession(id);
					if (live && !live.isStreaming()) void runtime.closeSession(id);
				}
			});

			// Replay buffered events after the client's Last-Event-ID, bounded by the watermark.
			const lastEventId = c.req.header("Last-Event-ID");
			if (lastEventId !== undefined) {
				const after = Number(lastEventId);
				for (const entry of sessionRing.get(id) ?? []) {
					if (entry.id > after && entry.id <= replayUpTo) {
						await stream.writeSSE({ id: String(entry.id), event: "message", data: entry.frame });
					}
				}
			}

			// hello = the session snapshot, so a fresh attach knows the current state at once.
			await stream.writeSSE({ event: "hello", data: JSON.stringify(sessionSnapshot(session)) });

			// Mandatory keepalive: Hono closes the stream when this callback returns, so the loop must run
			// for the connection's lifetime (Hono issue #2993). The heartbeat is a raw SSE comment.
			while (!stream.aborted) {
				await stream.sleep(KEEPALIVE_MS);
				if (stream.aborted) break;
				await stream.write(": ping\n\n");
			}
		}),
	);

	// Per-session command. The session id comes from the URL — it is the target for session-scoped verbs
	// and the UI rail for agent-global ones. Resolve (rehydrating if idle) before dispatch.
	app.post("/sessions/:id/control", async (c) => {
		const id = c.req.param("id");
		let cmd: DaemonCommand;
		try {
			cmd = await c.req.json<DaemonCommand>();
		} catch {
			return c.json(err(undefined, "unknown", "Malformed JSON body."));
		}
		let session: AgentSession;
		try {
			session = runtime.getSession(id) ?? (await runtime.openSession(id));
		} catch (e) {
			return c.json(err(cmd.id, cmd.type, e instanceof Error ? e.message : String(e)));
		}
		try {
			return c.json(await handleCommand(runtime, session, cmd, requestShutdown));
		} catch (e) {
			return c.json(err(cmd.id, cmd.type, e instanceof Error ? e.message : String(e)));
		}
	});

	// A client's answer to one of this session's awaited extension-UI dialogs — resolve the parked
	// promise by request id.
	app.post("/sessions/:id/ui-response", async (c) => {
		const id = c.req.param("id");
		let response: ExtensionUIResponse;
		try {
			response = await c.req.json<ExtensionUIResponse>();
		} catch {
			return c.json({ success: false, error: "Malformed JSON body." });
		}
		const pending = sessionPending.get(id);
		const parked = pending?.get(response.id);
		if (parked) {
			pending?.delete(response.id);
			parked.resolve(response);
		}
		return c.json({ success: true });
	});

	// A client's answer to one of this session's awaited login dialogs — resolve the parked promise by
	// request id (the login seam's analogue of /ui-response).
	app.post("/sessions/:id/login-response", async (c) => {
		const id = c.req.param("id");
		let response: LoginUIResponse;
		try {
			response = await c.req.json<LoginUIResponse>();
		} catch {
			return c.json({ success: false, error: "Malformed JSON body." });
		}
		const pending = loginPending.get(id);
		const parked = pending?.get(response.id);
		if (parked) {
			pending?.delete(response.id);
			parked.resolve(response);
		}
		return c.json({ success: true });
	});

	// ---- Serve ------------------------------------------------------------
	// Bind the agent's fixed host/port. The port is known up front (no patch-back); a clash with another
	// process surfaces as EADDRINUSE, which we report clearly and fail loud on.
	const host = getDaemonHost();
	const server = await new Promise<ServerType>((resolve, reject) => {
		const s = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(s));
		s.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code === "EADDRINUSE") {
				console.error(`${APP_NAME} daemon for "${runtime.config.name}": port ${port} already in use.`);
				process.exit(1);
			}
			reject(e);
		});
	});

	return server;
}
