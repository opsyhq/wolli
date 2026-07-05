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
 * exactly like extensions. Workflows bind their event descriptors as triggers, and
 * callers invoke their actions via `getIntegration(name).call(action, params)`.
 */

import type { Static, TSchema } from "typebox";
// Type-only imports — erased at compile time, so the extensions↔integrations
// type cycle (extensions/types.ts already imports this file) has no runtime edge.
import type { ExtensionUIContext } from "../extensions/types.ts";
import type { IntegrationAccountRecord } from "../integration-account-storage.ts";
import type { resolveConfigValueUncached } from "../resolve-config-value.ts";
import type { SourceInfo } from "../source-info.ts";
// Value import: `.on` funnels through defineWorkflow. The reverse edge (workflows importing
// this file's descriptor types) is type-only, so the runtime dependency stays one-directional.
import { defineWorkflow, type IntegrationWorkflowDefinition, type WorkflowContext } from "../workflows/types.ts";

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

/**
 * A callable request/response function exposed by an integration. `params` arrives
 * validated against `parameters` but stays `unknown` on the definer side (cast at the
 * boundary); caller-side typing on the `ctx.integration` handle comes from `parameters`
 * and the inferred `execute` return type.
 */
export interface IntegrationAction<TParams extends TSchema = TSchema> {
	description?: string;
	parameters: TParams;
	execute(params: unknown, ctx: IntegrationActionContext): Promise<unknown>;
}

export interface IntegrationRunContext {
	/** Resolved + validated against `config.account`. */
	account: unknown;
	/** Validated against `config.events[event]`. */
	emit(event: string, data: unknown): void;
	/** Durable per-service runtime state. */
	store: KeyValueStore;
	/** Aborted on `stop()`; one `run()` per service. */
	signal: AbortSignal;
}

export interface IntegrationActionContext {
	account: unknown;
	/** Durable per-service runtime state. */
	store: KeyValueStore;
	signal: AbortSignal;
}

export interface IntegrationHandle {
	/** Invoke an action by name; params validated against its schema. */
	call(action: string, params?: unknown): Promise<unknown>;
}

/**
 * A typed, inert event descriptor an integration definition exposes (e.g.
 * `telegram.events.message`) and a workflow binds with `on:`. Carries no behavior — just
 * the (service, event) address plus the payload type for handler inference.
 *
 * `service` is stamped by the integrations loader from the file basename, so it must stay
 * writable. `defineIntegration` always populates `schema`; it stays optional because test
 * fixtures mint descriptors inline.
 */
export interface IntegrationEventDescriptor<TPayload = unknown> {
	kind: "integration";
	service: string;
	event: string;
	schema?: TSchema;
	/** Phantom payload-type carrier; never present at runtime. */
	readonly _payload?: TPayload;
}

/** The payload type a descriptor carries — for workflow authors naming a handler's event type. */
export type IntegrationEventPayload<T> = T extends IntegrationEventDescriptor<infer TPayload> ? TPayload : never;

/**
 * The producer ctx as `defineIntegration` types it: `account` and `emit` narrowed from
 * the authored schemas. The runtime hands the same `IntegrationRunContext` object either
 * way; only the definer-side view narrows.
 */
export interface IntegrationRunContextOf<TAccount extends TSchema, TEvents extends Record<string, TSchema>>
	extends IntegrationRunContext {
	account: Static<TAccount>;
	emit<K extends keyof TEvents & string>(event: K, data: Static<TEvents[K]>): void;
}

/**
 * The raw authored configuration `defineIntegration` accepts (the file basename is the
 * service name), with `account`/`events`/`actions` carried generically so the definition
 * can type descriptors and the action handle.
 */
export interface IntegrationDefinitionConfig<
	TAccount extends TSchema,
	TEvents extends Record<string, TSchema>,
	TActions extends Record<string, IntegrationAction>,
> {
	/** Schema for ONE configured account record. */
	account?: TAccount;
	/** Named events this integration emits: event name to payload schema. */
	events?: TEvents;
	actions?: TActions;
	/** Long-running producer: opens a connection/loop and calls `ctx.emit`. */
	// biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would reject run() impls without a return statement
	run?(ctx: IntegrationRunContextOf<TAccount, TEvents>): void | (() => void) | Promise<void | (() => void)>;
	/**
	 * Guided first-run setup. Auto-runs on `plugins install` for an unconfigured
	 * service when attached to a TTY, or on demand via `plugins configure <source>`.
	 * Returns the ONE account record to persist, or `undefined` to cancel. Record values
	 * may be raw secrets or `$ENV`/`!cmd` references — `integrations.json` is written `0o600`.
	 */
	onboard?(ctx: IntegrationOnboardContext): Promise<IntegrationAccountRecord | undefined>;
}

/** An authored config with the generics erased — what a loaded `Integration` carries as `config`. */
export type LoadedIntegrationConfig = IntegrationDefinitionConfig<
	TSchema,
	Record<string, TSchema>,
	Record<string, IntegrationAction>
>;

/**
 * What `defineIntegration` returns: the typed handle other files import. `events` carries
 * one inert descriptor per authored event for workflow `on:` bindings; the raw authored
 * config rides on `.config` so the runner registers from it unchanged.
 */
export interface IntegrationDefinition<
	TAccount extends TSchema = TSchema,
	TEvents extends Record<string, TSchema> = Record<string, never>,
	TActions extends Record<string, IntegrationAction> = Record<string, never>,
> {
	kind: "integration";
	/** Stamped by the loader from the file basename; `""` until loaded. */
	service: string;
	events: { [K in keyof TEvents]: IntegrationEventDescriptor<Static<TEvents[K]>> };
	config: IntegrationDefinitionConfig<TAccount, TEvents, TActions>;
	/**
	 * Bind one of this integration's events to a workflow: `telegram.on("message", run)` — sugar
	 * for `defineWorkflow({ on: telegram.events.message, run })`, funnelling through the same primitive.
	 */
	on<K extends keyof TEvents & string>(
		event: K,
		run: (payload: Static<TEvents[K]>, ctx: WorkflowContext) => void | Promise<void>,
	): IntegrationWorkflowDefinition<Static<TEvents[K]>>;
	/**
	 * Phantom action-signature carrier (action name to call signature); never present at
	 * runtime. `IntegrationKey`/`IntegrationHandleOf` read it to type `ctx.integration`.
	 */
	readonly _actions?: {
		[K in keyof TActions]: (params: Static<TActions[K]["parameters"]>) => ReturnType<TActions[K]["execute"]>;
	};
}

/**
 * Define an integration. Mints one typed event descriptor per authored event; `service`
 * is `""` on the definition and its descriptors until the loader stamps the file basename.
 */
export function defineIntegration<
	TAccount extends TSchema = TSchema,
	TEvents extends Record<string, TSchema> = Record<string, never>,
	TActions extends Record<string, IntegrationAction> = Record<string, never>,
>(
	config: IntegrationDefinitionConfig<TAccount, TEvents, TActions>,
): IntegrationDefinition<TAccount, TEvents, TActions> {
	const events = {} as IntegrationDefinition<TAccount, TEvents, TActions>["events"];
	for (const [event, schema] of Object.entries(config.events ?? {})) {
		events[event as keyof TEvents] = { kind: "integration", service: "", event, schema };
	}
	return {
		kind: "integration",
		service: "",
		events,
		config,
		on<K extends keyof TEvents & string>(
			event: K,
			run: (payload: Static<TEvents[K]>, ctx: WorkflowContext) => void | Promise<void>,
		): IntegrationWorkflowDefinition<Static<TEvents[K]>> {
			return defineWorkflow({ on: events[event], run });
		},
	};
}

/** A loaded integration module — mirror of `Extension`. */
export interface Integration {
	path: string;
	resolvedPath: string;
	sourceInfo: SourceInfo;
	/** Loader-stamped service name. */
	service: string;
	/** The authored config, generics erased. */
	config: LoadedIntegrationConfig;
}

export interface LoadIntegrationsResult {
	integrations: Integration[];
	errors: Array<{ path: string; error: string }>;
}

/** Same shape as `ExtensionError` so integration errors ride the extension error sink unchanged. */
export interface IntegrationError {
	path: string;
	event: string;
	error: string;
	stack?: string;
}

export type IntegrationErrorListener = (error: IntegrationError) => void;
