/**
 * Daemon server + runner.
 *
 * `runDaemon(name, opts)` resolves the agent's model/auth, starts its `AgentRuntime`, then binds a
 * long-running loopback HTTP/SSE server around it and blocks until a signal tears it down:
 *
 *   - `GET /events`  (SSE)  — the curated event stream + async prompt acks;
 *   - `POST /control`       — commands, whose sync response is the HTTP body;
 *   - `GET /health`         — liveness, no auth.
 *
 * `AgentRuntime` owns every lifecycle concern (create/resume/reload/cleanup); the server is a
 * thin wrapper that calls into it. The `@opsyhq/cli` client's hidden `daemon` subcommand and every
 * OS service unit invoke `runDaemon`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import type { AgentHarness, AgentHarnessEvent } from "@opsyhq/agent";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { APP_NAME, ENV_DAEMON_TOKEN, getAgentDir, VERSION } from "./config.ts";
import { createAgentPluginManager } from "./core/agent-plugin-manager.ts";
import { AgentRuntime, type Conversation } from "./core/agent-runtime.ts";
import { AgentSettingsManager } from "./core/agent-settings-manager.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { loadDaemonConfig, saveDaemonConfig } from "./core/daemon-config.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "./core/extensions/index.ts";
import { IntegrationAccountStorage } from "./core/integration-account-storage.ts";
import { loadIntegrations } from "./core/integrations/loader.ts";
import { onboardIntegration } from "./core/integrations/onboarding.ts";
import type { Integration, IntegrationOnboardUI } from "./core/integrations/types.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import { findInitialModel } from "./core/model-resolver.ts";
import type { DefaultPluginManager } from "./core/plugin-manager.ts";
import { getServiceManager } from "./core/service/service-manager.ts";
import { type Theme, theme } from "./theme/theme.ts";
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
	type ScopedModelsUpdateEvent,
} from "./types.ts";
import { getCwdRelativePath, resolvePath } from "./utils/paths.ts";

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

/**
 * The `get_state` / `hello` snapshot. Config/cwd come from the runtime; model/thinking/scope/
 * streaming + session ids/counts come from the live conversation.
 */
function snapshot(runtime: AgentRuntime): DaemonSessionState {
	const conversation = runtime.getConversation();
	if (!conversation) throw new Error("AgentRuntime not started.");
	const harness = conversation.harness;
	return {
		model: harness.getModel(),
		thinkingLevel: harness.getThinkingLevel(),
		scopedModels: conversation.getScopedModels(),
		isStreaming: !harness.isIdle,
		sessionId: conversation.getSessionId(),
		sessionName: conversation.getSessionName(),
		sessionFile: conversation.getSessionFile(),
		messageCount: conversation.buildSessionContext().messages.length,
		pendingMessageCount: conversation.getPendingMessageCount(),
		config: runtime.config,
		cwd: runtime.getCwd(),
	};
}

/**
 * Drive the conversation's `prompt()` and ack the instant the prompt is accepted (handled, queued,
 * or about to run) rather than when the whole turn ends — `prompt()` only resolves at turn end.
 * The turn itself streams over SSE; `agent_end` marks completion.
 */
async function handlePrompt(
	conversation: Conversation,
	cmd: Extract<DaemonCommand, { type: "prompt" }>,
): Promise<DaemonResponse> {
	const accepted = deferred<void>();
	void conversation
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
 * Drive integration onboarding for the selected services, writing each credential through the runtime's
 * live account store (no cross-process staleness) and rendering `onboard(ctx)`'s dialogs via the
 * runner's bound `uiContext` (which emits them to attached clients). Returns structured per-service
 * results for the client to print.
 */
async function runDaemonOnboarding(
	runtime: AgentRuntime,
	selectServices: (input: { integrations: Integration[]; pluginManager: DefaultPluginManager }) => string[],
): Promise<OnboardServiceResult[]> {
	const name = runtime.config.name;
	const agentDir = getAgentDir(name);
	const { pluginManager } = createAgentPluginManager(name);
	const resolved = await pluginManager.resolve();
	const integrationPaths = resolved.integrations.filter((r) => r.enabled).map((r) => r.path);
	const { integrations } = await loadIntegrations(integrationPaths, agentDir);

	const services = selectServices({ integrations, pluginManager });
	// The runtime's live account store is the single writer; its bound uiContext renders dialogs over the wire.
	const accounts = runtime.integrationAccounts;
	const ui: IntegrationOnboardUI = runtime.extensionRunner.getUIContext();

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
async function handleCommand(runtime: AgentRuntime, cmd: DaemonCommand): Promise<DaemonResponse> {
	const id = cmd.id;
	const conversation = runtime.getConversation();
	if (!conversation) throw new Error("AgentRuntime not started.");
	const harness = conversation.harness;

	switch (cmd.type) {
		// Prompting
		case "prompt":
			return handlePrompt(conversation, cmd);
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
			return ok(id, "clear_queue", await conversation.clearQueue());
		case "new_session": {
			// A forming (undeployed) agent stays in its birth session; only a deploy-reason swap may
			// replace it. snapshot() re-resolves the new conversation after the swap.
			if (cmd.reason !== "deploy" && !AgentSettingsManager.create(runtime.config.name).getAgentDeployed()) {
				throw new Error("This agent is still forming — it stays in its birth session until it deploys.");
			}
			await runtime.createConversation();
			return ok(id, "new_session", snapshot(runtime));
		}
		case "reload":
			await runtime.reload();
			return ok(id, "reload");
		case "deploy": {
			// The human's single Yes. Flip the latch, register the OS service unit, and swap to a fresh
			// deployed session — persisted to disk, so the supervised daemon (which resumes the most-recent
			// session) picks up THIS fresh one. For a real backend, start the supervised daemon now: it
			// binds its own ephemeral port while this birth daemon keeps serving its own (two ephemeral
			// binds never collide). The client then reconnects to it and stops this daemon. With the `none`
			// backend there is no supervisor, so this daemon stays on the fresh session.
			const name = runtime.config.name;
			const serviceManager = getServiceManager();
			AgentSettingsManager.create(name).setAgentDeployed();
			serviceManager.install(name);
			// Latch already flipped, so swap unguarded to the fresh deployed session.
			await runtime.createConversation();
			if (serviceManager.kind !== "none") {
				serviceManager.start(name);
			}
			return ok(id, "deploy", snapshot(runtime));
		}

		// Model / thinking
		case "set_thinking_level":
			await conversation.setThinkingLevel(cmd.level);
			return ok(id, "set_thinking_level");
		case "set_model":
			return ok(id, "set_model", await conversation.setModelById(cmd.provider, cmd.modelId));
		case "get_available_models":
			return ok(id, "get_available_models", { models: runtime.getAvailableModels() });
		case "set_scoped_models":
			await conversation.setScopedModels(cmd.enabledModelIds);
			return ok(id, "set_scoped_models");
		case "set_enabled_models":
			runtime.setEnabledModels(cmd.enabledModels);
			return ok(id, "set_enabled_models");

		// Provider login — runs daemon-side; OAuth prompts ride the uiContext dialog seam.
		case "login":
			return ok(id, "login", await runtime.login(cmd.provider, cmd.authType));
		case "logout":
			return ok(id, "logout", runtime.logout(cmd.provider));
		case "get_login_providers":
			return ok(id, "get_login_providers", { providers: runtime.getLoginProviderOptions(cmd.authType) });
		case "get_logout_providers":
			return ok(id, "get_logout_providers", { providers: runtime.getLogoutProviderOptions() });

		// State
		case "get_state":
			return ok(id, "get_state", snapshot(runtime));
		case "get_messages":
			return ok(id, "get_messages", { messages: conversation.buildSessionContext().messages });
		case "get_commands":
			return ok(id, "get_commands", { commands: runtime.getCommands() });
		case "get_entries":
			return ok(id, "get_entries", { entries: conversation.getEntries() });
		case "get_resource_summary":
			return ok(id, "get_resource_summary", runtime.getResourceSummary());
		case "get_tool_info":
			return ok(id, "get_tool_info", {
				tools: runtime.getToolInfos(),
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
			return ok(id, "seed_assistant_message", await conversation.seedAssistantMessage(cmd.text));
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
		// Onboarding writes through the runtime's live account store, so no second reload is needed
		// (the credential is already in-memory-consistent); `install_plugin` did the reload. The
		// source scopes onboarding to the just-installed plugin's integrations that declare `onboard`.
		case "onboard_plugin":
			return ok(id, "onboard_plugin", {
				results: await runDaemonOnboarding(runtime, ({ integrations, pluginManager }) => {
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
 * Resolve model/auth once and construct the `AgentRuntime` — the front half of the daemon runner.
 * Returns the unstarted `runtime`, or an `{ error }` for the model/auth failures that should print to
 * stderr and exit 1.
 */
async function createAgentRuntime(name: string): Promise<{ runtime: AgentRuntime } | { error: string }> {
	const store = AgentSettingsManager.create(name);

	const authStorage = AuthStorage.create();
	// Integration accounts are per-agent (`~/.steward/agents/<name>/integrations.json`).
	const integrationAccounts = IntegrationAccountStorage.create(name);
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
	if (!resolved.model) {
		return { error: `No model available for agent "${name}". Log in with the steward CLI.` };
	}
	const model = resolved.model;

	// Auth precedence (handled by AuthStorage): runtime → auth.json (api key / OAuth)
	// → env var. hasAuth() doesn't refresh tokens — it just checks something exists.
	// If it returns false, every credential source (including the env var) is absent,
	// so the only actionable hint is to log in.
	if (!authStorage.hasAuth(model.provider)) {
		return { error: `No credentials found for provider "${model.provider}". Log in with the steward CLI.` };
	}

	const runtime = new AgentRuntime({ name, model, authStorage, modelRegistry, integrationAccounts });
	return { runtime };
}

export interface RunDaemonOptions {
	/** Manual bind-port override for this run (debugging); 0/absent → OS-assigned ephemeral. */
	port?: number;
}

/**
 * The `daemon <name>` runner: start the agent's `AgentRuntime`, then wrap it in a long-running
 * HTTP/SSE server clients attach to. Binds an OS-assigned ephemeral port (unless `--port` overrides),
 * writes the pid/port/token to the temp-dir config so clients can find it, and blocks on the listening
 * server until a signal tears it down. The `@opsyhq/cli` client's hidden `daemon` subcommand and every
 * OS service unit invoke this.
 */
export async function runDaemon(name: string, opts: RunDaemonOptions = {}): Promise<number> {
	if (!AgentSettingsManager.get(name)) {
		process.stderr.write(`Unknown agent "${name}". Create it with: ${APP_NAME} new ${name}\n`);
		return 1;
	}

	const built = await createAgentRuntime(name);
	if ("error" in built) {
		process.stderr.write(`${built.error}\n`);
		return 1;
	}
	const { runtime } = built;

	// Resume the agent's most-recent session. Scope is seeded from config inside the runtime.
	await runtime.resumeConversation();

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

	const server = await runDaemonMode(runtime, { port, token });

	// serve()'s callback patched the config with the OS-assigned port once listening.
	const boundPort = loadDaemonConfig(name)?.port ?? port;
	console.log(`${APP_NAME} daemon for "${name}" listening on http://127.0.0.1:${boundPort}`);

	// server.close() drops the broadcaster subscription (via the server's "close" listener); we then
	// release the runtime + config.
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		await runtime.cleanup();
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
 * Bind a loopback HTTP/SSE server wrapping `runtime`, subscribe the broadcaster to the live harness
 * (re-subscribing after every swap), and resolve once it is listening. Returns the `serve()` server
 * so `runDaemon` can `server.close()` on shutdown — closing the server drops the broadcaster
 * subscription (via the `close` listener below), the leak `runtime.cleanup()` does not cover. Exported
 * for the daemon integration test, which drives it directly against a faux runtime; not part of the SDK
 * barrel.
 */
export async function runDaemonMode(
	runtime: AgentRuntime,
	{ port, token }: { port: number; token: string },
): Promise<ServerType> {
	const startedAt = new Date().toISOString();

	// ---- Event broadcaster ------------------------------------------------
	const clients = new Set<SSEStreamingApi>();
	let seq = 0;
	const ring: { id: number; frame: string }[] = [];

	const broadcast = async (event: AgentHarnessEvent | ScopedModelsUpdateEvent): Promise<void> => {
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
	// Subscribe to the live conversation's harness; rebind re-points after every swap.
	const initialConversation = runtime.getConversation();
	if (initialConversation) resubscribe(initialConversation.harness);
	// Re-fire after every harness swap (build/newSession) and after reload.
	runtime.setRebindHandler(resubscribe);
	// Scoped-model scope changes are runtime-originated (not harness own-events), so bridge them
	// onto the same broadcaster the harness events ride.
	runtime.setScopedModelsHandler((scopedModels) => void broadcast({ type: "scoped_models_update", scopedModels }));

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

	runtime.bindInteractiveContext({
		uiContext,
		mode: "rpc",
		// Surface runner errors (extension + integration) to clients as error notifies.
		onError: (e) => uiContext.notify(`${e.path}: ${e.error}`, "error"),
		commandContextActions: {
			waitForIdle: () => runtime.getConversation()?.harness.waitForIdle() ?? Promise.resolve(),
			newSession: async () => {
				if (!AgentSettingsManager.create(runtime.config.name).getAgentDeployed()) {
					throw new Error("This agent is still forming — it stays in its birth session until it deploys.");
				}
				await runtime.createConversation();
				return { cancelled: false };
			},
			// Tree navigation is not a daemon concern — report cancelled.
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: () => runtime.reload(),
		},
	});

	// ---- HTTP app ---------------------------------------------------------
	const app = new Hono();
	app.use("/events", bearerAuth({ token }));
	app.use("/control", bearerAuth({ token }));
	app.use("/ui-response", bearerAuth({ token }));

	app.get("/health", (c) => c.json({ status: "ok", agent: runtime.config.name, pid: process.pid, startedAt }));

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
			await stream.writeSSE({ event: "hello", data: JSON.stringify(snapshot(runtime)) });

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
			return c.json(await handleCommand(runtime, cmd));
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
		const existing = loadDaemonConfig(runtime.config.name);
		if (existing) saveDaemonConfig(runtime.config.name, { ...existing, port });
	};

	const server = await new Promise<ServerType>((resolve) => {
		const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
			writePortBack(info.port);
			resolve(s);
		});
	});

	// runtime.cleanup() does NOT drop the broadcaster subscription, so tie it to server close.
	server.on("close", () => {
		try {
			unsubscribe?.();
		} catch {
			/* harness already gone with its subscription */
		}
	});

	return server;
}
