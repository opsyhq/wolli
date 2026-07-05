/**
 * Integration runner - runs integration producers and dispatches their events and actions.
 */

import { Compile } from "typebox/compile";
import type { IntegrationAccountRecord, IntegrationAccountStorage } from "../integration-account-storage.ts";
import type { IntegrationStore } from "../integration-store.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
import type {
	Integration,
	IntegrationActionContext,
	IntegrationError,
	IntegrationErrorListener,
	IntegrationHandle,
	IntegrationRunContext,
	KeyValueStore,
	LoadedIntegrationConfig,
} from "./types.ts";

type Validator = ReturnType<typeof Compile>;

/**
 * A registered integration: its pre-compiled validators plus the producer state
 * `start()` fills in. `controller`/`disposer`/`done` are absent until the producer runs
 * and are cleared by `stop()`.
 */
interface RegisteredIntegration {
	service: string;
	integrationPath: string;
	config: LoadedIntegrationConfig;
	/** Compiled account schema; absent when the integration has none. */
	accountValidator?: Validator;
	/** Compiled event-payload validators, keyed by event name. */
	eventValidators: Map<string, Validator>;
	/** Compiled action-parameter validators, keyed by action name. */
	actionValidators: Map<string, Validator>;
	/** Aborts the running producer; set by `start()`, cleared by `stop()`. */
	controller?: AbortController;
	/** The producer's returned disposer, if any. */
	disposer?: () => void;
	/** The producer's `run()` promise; its presence means the producer is attached. */
	done?: Promise<void>;
}

const STOP_GRACE_MS = 2000;

export class IntegrationRunner {
	private cwd: string;
	private accountStorage: IntegrationAccountStorage;
	private store: IntegrationStore;
	/** service → registered integration (first registration wins). */
	private registeredIntegrations: Map<string, RegisteredIntegration> = new Map();
	private errorListeners: Set<IntegrationErrorListener> = new Set();
	/** Firehose listeners: every validated event from every service. */
	private eventListeners: Set<(evt: { service: string; event: string; data: unknown }) => void> = new Set();

	constructor(
		integrations: Integration[],
		cwd: string,
		accountStorage: IntegrationAccountStorage,
		store: IntegrationStore,
	) {
		this.cwd = cwd;
		this.accountStorage = accountStorage;
		this.store = store;

		for (const integration of integrations) {
			if (this.registeredIntegrations.has(integration.service)) continue; // first registration wins
			this.registeredIntegrations.set(integration.service, {
				service: integration.service,
				integrationPath: integration.path,
				config: integration.config,
				eventValidators: new Map(),
				actionValidators: new Map(),
			});
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

	/** Compile validators. Does not start producers (see `start`). */
	bindCore(): void {
		for (const def of this.registeredIntegrations.values()) {
			this.compileIntegration(def);
		}
	}

	/** Per-service `ctx.store` handle, closing over the service so the integration sees only its own file. */
	private storeHandle(service: string): KeyValueStore {
		return {
			get: (key) => this.store.get(service, key),
			set: (key, value) => this.store.set(service, key, value),
			getAll: () => this.store.getAll(service),
			delete: (key) => this.store.delete(service, key),
		};
	}

	/**
	 * Resolve and validate the service's account record — the value handed to
	 * `ctx.account`. Throws if it is not configured or fails validation.
	 */
	private getAccount(def: RegisteredIntegration): IntegrationAccountRecord {
		const record = this.accountStorage.get(def.service);
		if (!record) {
			throw new Error(this.notConfiguredMessage(def.service));
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
			throw new Error(`invalid account for '${def.service}'${detail ? `: ${detail}` : ""}`);
		}

		return resolved;
	}

	/** The unconfigured-service error, with the configured services as a hint. */
	private notConfiguredMessage(service: string): string {
		const configured = this.accountStorage.listServices();
		return `integration '${service}' is not configured${
			configured.length > 0 ? ` (configured: ${configured.join(", ")})` : ""
		}`;
	}

	/** Start each configured producer once, skipping any already running. `run(ctx)` is non-blocking. */
	async start(): Promise<void> {
		for (const def of this.registeredIntegrations.values()) {
			const run = def.config.run;
			if (!run) continue;
			const service = def.service;

			if (!this.accountStorage.has(service)) continue; // unconfigured: no producer
			if (def.done !== undefined) continue; // producer already attached

			let account: unknown;
			try {
				account = this.getAccount(def);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({ path: def.integrationPath, event: "start", error: message, stack });
				continue;
			}

			const controller = new AbortController();
			def.controller = controller;

			const ctx: IntegrationRunContext = {
				account,
				store: this.storeHandle(service),
				signal: controller.signal,
				emit: (event, data) => this.emitIntegrationEvent(service, event, data),
			};

			// Non-blocking: capture the run promise as `done`; a returned function becomes the disposer.
			def.done = Promise.resolve()
				.then(() => run(ctx))
				.then((disposer) => {
					if (typeof disposer === "function") {
						def.disposer = disposer;
					}
				})
				.catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						path: def.integrationPath,
						event: "start",
						error: `integration '${service}': ${message}`,
						stack,
					});
				});
		}
	}

	/**
	 * Validate a producer-emitted event and fan it out to the firehose listeners.
	 * Bad events go to `emitError` and are dropped, never thrown back into the producer.
	 */
	private emitIntegrationEvent(service: string, event: string, data: unknown): void {
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

		// Firehose: every validated event, the only fan-out — the seam workflow dispatch
		// subscribes to. Only validated payloads ever reach it.
		for (const listener of this.eventListeners) {
			try {
				listener({ service, event, data });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: def.integrationPath,
					event,
					error: `event listener for '${event}' on integration '${service}' failed: ${message}`,
					stack,
				});
			}
		}
	}

	/**
	 * Handle bound to one service. Throws if the service is unknown or not configured.
	 * `call()` validates params and runs the action.
	 */
	getIntegration(service: string): IntegrationHandle {
		const def = this.registeredIntegrations.get(service);
		if (!def) {
			throw new Error(`integration '${service}' not found`);
		}
		if (!this.accountStorage.has(service)) {
			throw new Error(this.notConfiguredMessage(service));
		}

		const runner = this;
		return {
			call(action: string, params?: unknown): Promise<unknown> {
				return runner.callAction(def, action, params);
			},
		};
	}

	private async callAction(def: RegisteredIntegration, action: string, params?: unknown): Promise<unknown> {
		const actionDef = def.config.actions?.[action];
		if (!actionDef) {
			throw new Error(`unknown action '${action}' for integration '${def.service}'`);
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

		const resolvedAccount = this.getAccount(def);
		// Reuse the live producer's controller when present, else a per-call one.
		const controller = def.controller ?? new AbortController();
		const ctx: IntegrationActionContext = {
			account: resolvedAccount,
			store: this.storeHandle(def.service),
			signal: controller.signal,
		};
		return actionDef.execute(args, ctx);
	}

	/** Subscribe to the validated-event firehose (every service); returns an unsubscribe function. */
	onEvent(listener: (evt: { service: string; event: string; data: unknown }) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
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
	 * Producer state is cleared so a later `start()` re-attaches; the account store is left intact.
	 */
	async stop(): Promise<void> {
		for (const def of this.registeredIntegrations.values()) {
			if (def.controller === undefined && def.done === undefined) continue; // no producer attached

			def.controller?.abort();
			try {
				def.disposer?.();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: def.integrationPath,
					event: "stop",
					error: message,
					stack,
				});
			}
			if (def.done) {
				await this.raceWithTimeout(def.done, STOP_GRACE_MS);
			}
			def.controller = undefined;
			def.disposer = undefined;
			def.done = undefined;
		}
	}
}
