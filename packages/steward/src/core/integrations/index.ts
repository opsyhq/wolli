/**
 * Integration subsystem: a bidirectional capability primitive (actions + events +
 * a long-running producer) installed as a package resource (resolved in place by
 * the package manager) and consumed by extensions via `getIntegration`.
 */

export { createIntegrationRuntime, loadIntegrationFromFactory, loadIntegrations } from "./loader.ts";
export { IntegrationRunner } from "./runner.ts";
export type {
	Integration,
	IntegrationAction,
	IntegrationActionContext,
	IntegrationConfig,
	IntegrationError,
	IntegrationErrorListener,
	IntegrationFactory,
	IntegrationHandle,
	IntegrationOnboardContext,
	IntegrationOnboardUI,
	IntegrationRunContext,
	IntegrationRuntime,
	IntegrationRuntimeState,
	IntegrationsAPI,
	LoadIntegrationsResult,
} from "./types.ts";
