/**
 * Integration runner - runs integration producers and dispatches their events and actions.
 */

import * as path from "node:path";
import { Compile } from "typebox/compile";
import type { IntegrationAccountRecord, IntegrationAccountStorage } from "../integration-account-storage.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
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

/** A registered integration with its pre-compiled validators. */
interface RegisteredIntegration {
	service: string;
	integrationPath: string;
	config: IntegrationConfig;
	/** Compiled account schema; absent when the integration has none. */
	accountValidator?: Validator;
	/** Compiled event-payload validators, keyed by event name. */
	eventValidators: Map<string, Validator>;
	/** Compiled action-parameter validators, keyed by action name. */
	actionValidators: Map<string, Validator>;
}

/** A live (service, account): `on()` attaches listeners; `start()` fills in the running producer. */
interface LiveIntegrationAccount {
	listeners: Map<string, Set<(data: unknown) => void | Promise<void>>>;
	controller?: AbortController;
	disposer?: () => void;
	done?: Promise<void>;
	/** Per-account client cache (unused). */
	client?: unknown;
}

const STOP_GRACE_MS = 2000;

export class IntegrationRunner {
	private runtime: IntegrationRuntime;
	private cwd: string;
	private accountStorage: IntegrationAccountStorage;
	/** service → registered integration (first registration wins). */
	private registeredIntegrations: Map<string, RegisteredIntegration> = new Map();
	/** key (`service accountId`) → live account. */
	private liveAccounts: Map<string, LiveIntegrationAccount> = new Map();
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
				if (this.registeredIntegrations.has(service)) continue; // first registration wins
				this.registeredIntegrations.set(service, {
					service,
					integrationPath: integration.path,
					config,
					eventValidators: new Map(),
					actionValidators: new Map(),
				});
			}
		}
	}

	/** The runtime cwd. */
	getCwd(): string {
		return this.cwd;
	}

	/** Registered service ids. */
	getServices(): string[] {
		return Array.from(this.registeredIntegrations.keys());
	}

	/** Per-service action + event name lists, for capability display. */
	getServiceCapabilities(): Array<{ service: string; actions: string[]; events: string[] }> {
		return Array.from(this.registeredIntegrations.values()).map((def) => ({
			service: def.service,
			actions: Object.keys(def.config.actions ?? {}),
			events: Object.keys(def.config.events ?? {}),
		}));
	}

	private defaultServiceName(integrationPath: string): string {
		if (integrationPath.startsWith("<") && integrationPath.endsWith(">")) {
			return integrationPath.slice(1, -1).split(":")[0] || "integration";
		}
		return path.basename(integrationPath, path.extname(integrationPath));
	}

	private compileIntegration(def: RegisteredIntegration): void {
		if (def.config.account) {
			def.accountValidator = Compile(def.config.account);
		}
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

	/** Compile validators and bind runtime registration. Does not start producers (see `start`). */
	bindCore(): void {
		for (const def of this.registeredIntegrations.values()) {
			this.compileIntegration(def);
		}

		// After bind, register/unregister take effect immediately (producers are not auto-started).
		this.runtime.registerIntegration = (config, integrationPath = "<unknown>") => {
			const service = config.name ?? this.defaultServiceName(integrationPath);
			if (this.registeredIntegrations.has(service)) return;
			const def: RegisteredIntegration = {
				service,
				integrationPath,
				config,
				eventValidators: new Map(),
				actionValidators: new Map(),
			};
			this.compileIntegration(def);
			this.registeredIntegrations.set(service, def);
		};
		this.runtime.unregisterIntegration = (name) => {
			this.registeredIntegrations.delete(name);
		};
	}

	private liveKey(service: string, account: string): string {
		return `${service} ${account}`;
	}

	private ensureEntry(key: string): LiveIntegrationAccount {
		let entry = this.liveAccounts.get(key);
		if (!entry) {
			entry = { listeners: new Map() };
			this.liveAccounts.set(key, entry);
		}
		return entry;
	}

	/**
	 * Resolve and validate the account for `(service, account)` — the value handed to
	 * `ctx.account`. Throws if it is not configured or fails validation.
	 */
	private getAccount(def: RegisteredIntegration, account: string): IntegrationAccountRecord {
		const record = this.accountStorage.get(def.service, account);
		if (!record) {
			const configured = this.accountStorage.listAccounts(def.service);
			throw new Error(
				`account '${account}' not configured for '${def.service}'${
					configured.length > 0 ? ` (configured: ${configured.join(", ")})` : ""
				}`,
			);
		}

		const resolved: IntegrationAccountRecord = {};
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "string") {
				const resolvedValue = resolveConfigValue(value);
				if (resolvedValue !== undefined) {
					resolved[key] = resolvedValue;
				}
				continue;
			}
			resolved[key] = value;
		}

		if (def.accountValidator && !def.accountValidator.Check(resolved)) {
			const detail = def.accountValidator
				.Errors(resolved)
				.map((e) => `${e.instancePath || "root"}: ${e.message}`)
				.join("; ");
			throw new Error(`invalid account '${account}' for '${def.service}'${detail ? `: ${detail}` : ""}`);
		}

		return resolved;
	}

	/** Start each configured producer once, skipping any already running. `run(ctx)` is non-blocking. */
	async start(): Promise<void> {
		for (const def of this.registeredIntegrations.values()) {
			const run = def.config.run;
			if (!run) continue;
			const service = def.service;

			for (const accountId of this.accountStorage.listAccounts(service)) {
				const key = this.liveKey(service, accountId);
				const existing = this.liveAccounts.get(key);
				if (existing?.done !== undefined) continue; // producer already attached

				let account: unknown;
				try {
					account = this.getAccount(def, accountId);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({ path: def.integrationPath, event: "start", error: message, stack });
					continue;
				}

				const entry = this.ensureEntry(key);
				const controller = new AbortController();
				entry.controller = controller;

				const ctx: IntegrationRunContext = {
					account,
					signal: controller.signal,
					emit: (event, data) => {
						void this.emitIntegrationEvent(service, accountId, event, data);
					},
				};

				// Non-blocking: capture the run promise as `done`; a returned function becomes the disposer.
				entry.done = Promise.resolve()
					.then(() => run(ctx))
					.then((disposer) => {
						if (typeof disposer === "function") {
							entry.disposer = disposer;
						}
					})
					.catch((err) => {
						const message = err instanceof Error ? err.message : String(err);
						const stack = err instanceof Error ? err.stack : undefined;
						this.emitError({
							path: def.integrationPath,
							event: "start",
							error: `integration '${service}' account '${accountId}': ${message}`,
							stack,
						});
					});
			}
		}
	}

	/**
	 * Validate a producer-emitted event and fan it out to listeners for `(service, account)`.
	 * Bad events go to `emitError` and are dropped, never thrown back into the producer.
	 */
	private async emitIntegrationEvent(service: string, account: string, event: string, data: unknown): Promise<void> {
		const def = this.registeredIntegrations.get(service);
		if (!def) {
			this.emitError({
				path: "<unknown>",
				event,
				error: `emit from unknown integration '${service}'`,
			});
			return;
		}

		const validator = def.eventValidators.get(event);
		if (!validator) {
			this.emitError({
				path: def.integrationPath,
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
				path: def.integrationPath,
				event,
				error: `invalid '${event}' payload for integration '${service}'${detail ? `: ${detail}` : ""}`,
			});
			return;
		}

		const entry = this.liveAccounts.get(this.liveKey(service, account));
		const listeners = entry?.listeners.get(event);
		if (!listeners || listeners.size === 0) return;

		for (const listener of listeners) {
			try {
				await listener(data);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: def.integrationPath,
					event,
					error: `listener for '${event}' on integration '${service}' failed: ${message}`,
					stack,
				});
			}
		}
	}

	/**
	 * Handle bound to `(service, account)`. Throws if the service is unknown or the account
	 * is not configured. `on()` attaches a listener; `call()` validates params and runs the action.
	 */
	getIntegration(service: string, account = "default"): IntegrationHandle {
		const def = this.registeredIntegrations.get(service);
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
		def: RegisteredIntegration,
		service: string,
		account: string,
		action: string,
		params?: unknown,
	): Promise<unknown> {
		const actionDef = def.config.actions?.[action];
		if (!actionDef) {
			throw new Error(`unknown action '${action}' for integration '${service}'`);
		}

		// Precompiled at bindCore; compile on demand if called before bind.
		const validator = def.actionValidators.get(action) ?? Compile(actionDef.parameters);
		const args = params ?? {};
		if (!validator.Check(args)) {
			const detail = validator
				.Errors(args)
				.map((e) => `${e.instancePath || "root"}: ${e.message}`)
				.join("; ");
			throw new Error(`invalid params for action '${action}'${detail ? `: ${detail}` : ""}`);
		}

		const resolvedAccount = this.getAccount(def, account);
		// Reuse the live producer's controller when present, else a per-call one.
		const entry = this.liveAccounts.get(this.liveKey(service, account));
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
	 * Stop every live producer: abort, dispose, await `done` up to a grace timeout.
	 * Listener sets are kept so a later `start()` re-attaches; the account store is left intact.
	 */
	async stop(): Promise<void> {
		for (const entry of this.liveAccounts.values()) {
			if (entry.controller === undefined && entry.done === undefined) continue; // listener-only

			entry.controller?.abort();
			try {
				entry.disposer?.();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: "<unknown>",
					event: "stop",
					error: message,
					stack,
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
