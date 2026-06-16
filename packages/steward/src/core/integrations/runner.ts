/**
 * Integration runner — mirror of `ExtensionRunner`. Owns producer lifecycle
 * (`run(ctx)` start/stop) and dispatch (events out to listeners, actions in).
 *
 * Lifecycle differs deliberately from extensions: producers hold exclusive live
 * connections (e.g. Telegram's 409-on-double-poll), so on reload the host stops the
 * previous runner BEFORE starting the new one (extensions, being pure dispatch, swap
 * new-before-old). The account store is process-scoped and never torn down here.
 */

import * as path from "node:path";
import { Compile } from "typebox/compile";
import type { IntegrationAccountStorage } from "../integration-account-storage.ts";
import type {
	Integration,
	IntegrationActionContext,
	IntegrationConfig,
	IntegrationError,
	IntegrationErrorListener,
	IntegrationHandle,
	IntegrationRunContext,
	IntegrationRuntime,
} from "./types.ts";

type Validator = ReturnType<typeof Compile>;

/** A registered integration definition with its pre-compiled validators. */
interface RegisteredDef {
	service: string;
	integrationPath: string;
	config: IntegrationConfig;
	/** `Compile`d per `events[event]` at `bindCore` (hot path). */
	eventValidators: Map<string, Validator>;
	/** `Compile`d per `actions[name].parameters` at `bindCore` (hot path). */
	actionValidators: Map<string, Validator>;
}

/**
 * A live `(service, account)` entry. Two-phase: `getIntegration().on()` creates an
 * entry holding ONLY `listeners`; `start()` fills the producer fields in place.
 */
interface LiveEntry {
	listeners: Map<string, Set<(data: unknown) => void | Promise<void>>>;
	controller?: AbortController;
	disposer?: () => void;
	done?: Promise<void>;
	/** Per-(service, account) client cache (unused in v1). */
	client?: unknown;
}

const STOP_GRACE_MS = 2000;

export class IntegrationRunner {
	private runtime: IntegrationRuntime;
	private cwd: string;
	private accountStorage: IntegrationAccountStorage;
	/** service → registered definition (first registration per service wins). */
	private definitions: Map<string, RegisteredDef> = new Map();
	/** `${service} ${accountId}` → live entry. */
	private live: Map<string, LiveEntry> = new Map();
	private errorListeners: Set<IntegrationErrorListener> = new Set();

	constructor(
		integrations: Integration[],
		runtime: IntegrationRuntime,
		cwd: string,
		accountStorage: IntegrationAccountStorage,
	) {
		this.runtime = runtime;
		this.cwd = cwd;
		this.accountStorage = accountStorage;

		for (const integration of integrations) {
			for (const [service, config] of integration.definitions) {
				if (this.definitions.has(service)) continue; // first registration wins
				this.definitions.set(service, {
					service,
					integrationPath: integration.path,
					config,
					eventValidators: new Map(),
					actionValidators: new Map(),
				});
			}
		}
	}

	/** The runtime cwd (exec/client seam). */
	getCwd(): string {
		return this.cwd;
	}

	/** Service ids that have a registered definition. */
	getServices(): string[] {
		return Array.from(this.definitions.keys());
	}

	private defaultServiceName(integrationPath: string): string {
		if (integrationPath.startsWith("<") && integrationPath.endsWith(">")) {
			return integrationPath.slice(1, -1).split(":")[0] || "integration";
		}
		return path.basename(integrationPath, path.extname(integrationPath));
	}

	private compileDef(def: RegisteredDef): void {
		if (def.config.events) {
			for (const [event, schema] of Object.entries(def.config.events)) {
				def.eventValidators.set(event, Compile(schema));
			}
		}
		if (def.config.actions) {
			for (const [name, action] of Object.entries(def.config.actions)) {
				def.actionValidators.set(name, Compile(action.parameters));
			}
		}
	}

	/**
	 * Pre-compile the hot-path validators and rebind the runtime's registration
	 * methods for immediate post-bind effect. Does NOT start producers (see `start`).
	 *
	 * Account-schema validation is owned by the account store's `resolveAccount`
	 * (cold path), so `bindCore` compiles only the event/action validators.
	 */
	bindCore(): void {
		for (const def of this.definitions.values()) {
			this.compileDef(def);
		}

		// From here, registration takes effect immediately. NOTE: producers for
		// dynamically-registered integrations are not auto-started in v1 (seam — `start()`
		// runs once during host build).
		this.runtime.registerIntegration = (config, integrationPath = "<unknown>") => {
			const service = config.name ?? this.defaultServiceName(integrationPath);
			if (this.definitions.has(service)) return;
			const def: RegisteredDef = {
				service,
				integrationPath,
				config,
				eventValidators: new Map(),
				actionValidators: new Map(),
			};
			this.compileDef(def);
			this.definitions.set(service, def);
		};
		this.runtime.unregisterIntegration = (name) => {
			this.definitions.delete(name);
		};
	}

	private liveKey(service: string, account: string): string {
		return `${service} ${account}`;
	}

	private ensureEntry(key: string): LiveEntry {
		let entry = this.live.get(key);
		if (!entry) {
			entry = { listeners: new Map() };
			this.live.set(key, entry);
		}
		return entry;
	}

	/**
	 * Start configured producers. Per registered definition with a `run`, for each
	 * configured account: skip if a producer is already attached (`entry?.done !==
	 * undefined` — producer-liveness, NOT mere map presence, since `.on()` creates
	 * listener-only entries beforehand). `run(ctx)` is invoked NON-BLOCKING: its
	 * return promise is captured as `done`; a returned function becomes the `disposer`.
	 */
	async start(): Promise<void> {
		for (const def of this.definitions.values()) {
			const run = def.config.run;
			if (!run) continue;
			const service = def.service;

			for (const accountId of this.accountStorage.listAccounts(service)) {
				const key = this.liveKey(service, accountId);
				const existing = this.live.get(key);
				if (existing?.done !== undefined) continue; // producer already attached

				let account: unknown;
				try {
					account = this.accountStorage.resolveAccount(service, accountId, def.config.account);
				} catch (err) {
					this.emitError({
						integrationPath: def.integrationPath,
						service,
						account: accountId,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
					continue;
				}

				const entry = this.ensureEntry(key);
				const controller = new AbortController();
				entry.controller = controller;

				const ctx: IntegrationRunContext = {
					account,
					signal: controller.signal,
					emit: (event, data) => {
						void this.emitFrom(service, accountId, event, data);
					},
				};

				// Non-blocking: capture run()'s promise as `done` (a long-running producer
				// never resolves it, which is fine — start() does not await). A sync return is
				// wrapped so a synchronous throw is also routed to the error channel.
				entry.done = Promise.resolve()
					.then(() => run(ctx))
					.then((disposer) => {
						if (typeof disposer === "function") {
							entry.disposer = disposer;
						}
					})
					.catch((err) => {
						this.emitError({
							integrationPath: def.integrationPath,
							service,
							account: accountId,
							error: err instanceof Error ? err.message : String(err),
							stack: err instanceof Error ? err.stack : undefined,
						});
					});
			}
		}
	}

	/**
	 * Fan an emitted event out to the live listeners for `(service, account, event)`.
	 * Validates against the pre-compiled checker (unknown event or bad payload →
	 * emitError + drop; NEVER throws into the producer). A known event with zero live
	 * listeners is silently dropped (v1 — see Risk 7 in the plan). Listeners run
	 * sequentially with per-listener try/catch (backpressure).
	 */
	private async emitFrom(service: string, account: string, event: string, data: unknown): Promise<void> {
		const def = this.definitions.get(service);
		if (!def) {
			this.emitError({
				integrationPath: "<unknown>",
				service,
				account,
				event,
				error: `emit from unknown integration '${service}'`,
			});
			return;
		}

		const validator = def.eventValidators.get(event);
		if (!validator) {
			this.emitError({
				integrationPath: def.integrationPath,
				service,
				account,
				event,
				error: `unknown event '${event}' for integration '${service}'`,
			});
			return;
		}

		if (!validator.Check(data)) {
			const detail = validator
				.Errors(data)
				.map((e) => `${e.instancePath || "root"}: ${e.message}`)
				.join("; ");
			this.emitError({
				integrationPath: def.integrationPath,
				service,
				account,
				event,
				error: `invalid '${event}' payload${detail ? `: ${detail}` : ""}`,
			});
			return;
		}

		const entry = this.live.get(this.liveKey(service, account));
		const listeners = entry?.listeners.get(event);
		if (!listeners || listeners.size === 0) return;

		for (const listener of listeners) {
			try {
				await listener(data);
			} catch (err) {
				this.emitError({
					integrationPath: def.integrationPath,
					service,
					account,
					event,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
	}

	/**
	 * Get a handle bound to `(service, account)`. Throws a clear error when the service
	 * is unknown or the account is not configured. `on()` attaches a listener (so
	 * subscriptions made before `start()` don't miss early events); `call()` validates
	 * params and runs the action.
	 */
	getIntegration(service: string, account = "default"): IntegrationHandle {
		const def = this.definitions.get(service);
		if (!def) {
			throw new Error(`integration '${service}' not found`);
		}
		if (!this.accountStorage.has(service, account)) {
			const configured = this.accountStorage.listAccounts(service);
			throw new Error(
				`account '${account}' not configured for '${service}'${
					configured.length > 0 ? ` (configured: ${configured.join(", ")})` : ""
				}`,
			);
		}

		const key = this.liveKey(service, account);
		const runner = this;
		return {
			on(event: string, handler: (data: unknown) => void | Promise<void>): () => void {
				const entry = runner.ensureEntry(key);
				let set = entry.listeners.get(event);
				if (!set) {
					set = new Set();
					entry.listeners.set(event, set);
				}
				set.add(handler);
				return () => {
					set?.delete(handler);
				};
			},
			call(action: string, params?: unknown): Promise<unknown> {
				return runner.callAction(def, service, account, action, params);
			},
		};
	}

	private async callAction(
		def: RegisteredDef,
		service: string,
		account: string,
		action: string,
		params?: unknown,
	): Promise<unknown> {
		const actionDef = def.config.actions?.[action];
		if (!actionDef) {
			throw new Error(`unknown action '${action}' for integration '${service}'`);
		}

		// Validator is precompiled at bindCore; compile on demand if called pre-bind.
		const validator = def.actionValidators.get(action) ?? Compile(actionDef.parameters);
		const args = params ?? {};
		if (!validator.Check(args)) {
			const detail = validator
				.Errors(args)
				.map((e) => `${e.instancePath || "root"}: ${e.message}`)
				.join("; ");
			throw new Error(`invalid params for action '${action}'${detail ? `: ${detail}` : ""}`);
		}

		const resolvedAccount = this.accountStorage.resolveAccount(service, account, def.config.account);
		// Reuse the live producer's controller when present; otherwise a per-call controller
		// (and a per-call client — no shared rate-limit bucket; acceptable v1).
		const entry = this.live.get(this.liveKey(service, account));
		const controller = entry?.controller ?? new AbortController();
		const ctx: IntegrationActionContext = { account: resolvedAccount, signal: controller.signal };
		return actionDef.execute(args, ctx);
	}

	onError(listener: IntegrationErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: IntegrationError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	private async raceWithTimeout(done: Promise<void>, ms: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const t = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		});
		try {
			await Promise.race([done, t]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Stop every live producer: abort its signal, call its disposer (try/catch), then
	 * await `done` against a grace timeout. Listener sets are kept so a subsequent
	 * `start()` re-attaches; the account store is left intact.
	 */
	async stop(): Promise<void> {
		for (const entry of this.live.values()) {
			if (entry.controller === undefined && entry.done === undefined) continue; // listener-only

			entry.controller?.abort();
			try {
				entry.disposer?.();
			} catch (err) {
				this.emitError({
					integrationPath: "<unknown>",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
			if (entry.done) {
				await this.raceWithTimeout(entry.done, STOP_GRACE_MS);
			}
			entry.controller = undefined;
			entry.disposer = undefined;
			entry.done = undefined;
			entry.client = undefined;
		}
	}
}
