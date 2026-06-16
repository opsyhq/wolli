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
 *    one genuinely new concept (steward is otherwise pull/request-response).
 *
 * Definitions live in a per-agent `integrations/` folder, discovered and loaded
 * exactly like extensions. Extensions consume them via
 * `getIntegration(name, account)` — `.on(event, handler)` to listen and
 * `.call(action, params)` to invoke.
 */

import type { TSchema } from "typebox";
import type { SourceInfo } from "../source-info.ts";

/** A callable request/response function exposed by an integration. */
export interface IntegrationAction {
	description?: string;
	parameters: TSchema;
	execute(params: unknown, ctx: IntegrationActionContext): Promise<unknown>;
}

/** The definition an integration factory registers via `steward.registerIntegration`. */
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
}

export interface IntegrationRunContext {
	/** Resolved + validated against `config.account`. */
	account: unknown;
	/** Validated against `config.events[event]`. */
	emit(event: string, data: unknown): void;
	/** Aborted on `stop()`; one `run()` per (service, account). */
	signal: AbortSignal;
}

export interface IntegrationActionContext {
	account: unknown;
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

export type IntegrationFactory = (steward: IntegrationsAPI) => void | Promise<void>;

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

/** An error surfaced by an integration's producer or dispatch, tagged with `service`/`account`/`event` when known. */
export interface IntegrationError {
	integrationPath: string;
	service?: string;
	account?: string;
	event?: string;
	error: string;
	stack?: string;
}

export type IntegrationErrorListener = (error: IntegrationError) => void;
