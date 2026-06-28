/**
 * Integration subsystem types.
 *
 * An integration is an extension-level capability primitive — a sibling to
 * `registerTool`/`registerProvider` — modeling a bidirectional port to the
 * outside world:
 *
 *  - **actions** — callable request/response functions (e.g. `sendMessage`): a
 *    `ToolDefinition` with the `<TParams>` generic dropped (`parameters: TSchema`
 *    + `execute(params: unknown, ctx)`), validated at the boundary.
 *  - **events + a long-running producer `run(ctx)`** — `run` opens a connection
 *    or loop and calls `ctx.emit("<event>", data)` per inbound item. This is the
 *    one genuinely new concept (wolli is otherwise pull/request-response).
 *
 * Definitions live in a per-agent `integrations/` folder, discovered and loaded
 * exactly like extensions. Extensions consume them via
 * `getIntegration(name, account)` — `.on(event, handler)` to listen and
 * `.call(action, params)` to invoke.
 */

import type { TSchema } from "typebox";
// Type-only imports — erased at compile time, so the extensions↔integrations
// type cycle (extensions/types.ts already imports this file) has no runtime edge.
import type { ExtensionUIContext } from "../extensions/types.ts";
import type { IntegrationAccountRecord } from "../integration-account-storage.ts";
import type { resolveConfigValueUncached } from "../resolve-config-value.ts";
import type { SourceInfo } from "../source-info.ts";

/**
 * The narrowed UI surface an integration's `onboard(ctx)` may use — the dialog
 * primitives only, no chat chrome (editor/widgets/footer/theme). Mirrors
 * `ProjectTrustContext.ui` (a `Pick` of `ExtensionUIContext`). `custom` is excluded:
 * onboarding dialogs are serialized to attached clients, and a component factory can't
 * cross that boundary. Calling anything outside this set is a compile error rather than a
 * silent no-op.
 */
export type IntegrationOnboardUI = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;

/**
 * Context handed to an integration's `onboard(ctx)` during guided setup: the narrowed
 * dialog surface (`ui`), a live credential resolver (`resolve`) so the author can test a
 * typed `$ENV` reference before returning it, and an abort `signal`.
 */
export interface IntegrationOnboardContext {
	/** Dialog primitives: select / confirm / input / notify. */
	ui: IntegrationOnboardUI;
	/** Resolve a `$ENV` / `${ENV}` / `!cmd` reference to its live value (to test a credential). */
	resolve: typeof resolveConfigValueUncached;
	signal: AbortSignal;
}

/**
 * A string-keyed store an integration uses for its durable runtime state (`ctx.store`),
 * scoped to one service. Backed by `~/.wolli/agents/<name>/store/<service>.json`,
 * process-scoped, and survives `/reload` — where an integration keeps machine-written
 * state (e.g. the scheduler's jobs).
 */
export interface KeyValueStore {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	getAll(): Record<string, unknown>;
	delete(key: string): void;
}

/** A callable request/response function exposed by an integration. */
export interface IntegrationAction {
	description?: string;
	parameters: TSchema;
	execute(params: unknown, ctx: IntegrationActionContext): Promise<unknown>;
}

/** The definition an integration factory registers via `wolli.registerIntegration`. */
export interface IntegrationConfig {
	/** Service id; defaults to the file/dir basename. */
	name?: string;
	/** Schema for ONE configured account record. */
	account?: TSchema;
	/** Named events this integration emits. */
	events?: Record<string, TSchema>;
	actions?: Record<string, IntegrationAction>;
	/** Long-running producer: opens a connection/loop and calls `ctx.emit`. */
	run?(ctx: IntegrationRunContext): void | (() => void) | Promise<void | (() => void)>;
	/**
	 * Guided first-run setup. Auto-runs on `plugins install` for an unconfigured
	 * service when attached to a TTY, or on demand via `plugins configure <source>`.
	 * Returns ONE account record to persist, or `undefined` to cancel. Record values
	 * may be raw secrets or `$ENV`/`!cmd` references — `integrations.json` is written `0o600`.
	 */
	onboard?(ctx: IntegrationOnboardContext): Promise<IntegrationAccountRecord | undefined>;
}

export interface IntegrationRunContext {
	/** Resolved + validated against `config.account`. */
	account: unknown;
	/** Validated against `config.events[event]`. */
	emit(event: string, data: unknown): void;
	/** Durable per-service runtime state. */
	store: KeyValueStore;
	/** Aborted on `stop()`; one `run()` per (service, account). */
	signal: AbortSignal;
}

export interface IntegrationActionContext {
	account: unknown;
	/** Durable per-service runtime state. */
	store: KeyValueStore;
	signal: AbortSignal;
}

export interface IntegrationHandle {
	/** Subscribe to an event; returns an unsubscribe function. */
	on(event: string, handler: (data: unknown) => void | Promise<void>): () => void;
	/** Invoke an action by name; params validated against its schema. */
	call(action: string, params?: unknown): Promise<unknown>;
}

/** Definer side — the argument passed to an integration factory. */
export interface IntegrationsAPI {
	registerIntegration(config: IntegrationConfig): void;
	unregisterIntegration(name: string): void;
}

export type IntegrationFactory = (wolli: IntegrationsAPI) => void | Promise<void>;

/** A loaded integration module — mirror of `Extension`. */
export interface Integration {
	path: string;
	resolvedPath: string;
	sourceInfo: SourceInfo;
	definitions: Map<string, IntegrationConfig>;
}

/** Registration surface for the integration runtime; `registerIntegration` writes definitions directly at load time. */
export interface IntegrationRuntimeState {
	assertActive: () => void;
	invalidate: (message?: string) => void;
	registerIntegration: (config: IntegrationConfig, integrationPath?: string) => void;
	unregisterIntegration: (name: string, integrationPath?: string) => void;
}

export interface IntegrationRuntime extends IntegrationRuntimeState {}

export interface LoadIntegrationsResult {
	integrations: Integration[];
	errors: Array<{ path: string; error: string }>;
	runtime: IntegrationRuntime;
}

/** Same shape as `ExtensionError` so integration errors ride the extension error sink unchanged. */
export interface IntegrationError {
	path: string;
	event: string;
	error: string;
	stack?: string;
}

export type IntegrationErrorListener = (error: IntegrationError) => void;
