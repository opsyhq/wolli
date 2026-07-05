/**
 * Integration subsystem: a bidirectional capability primitive (actions + events +
 * a long-running producer) installed as a package resource (resolved in place by
 * the package manager). Workflows bind its events; callers invoke its actions via
 * `getIntegration(service).call(...)`.
 */

export { loadIntegrationFromDefinition, loadIntegrations } from "./loader.ts";
export { IntegrationRunner } from "./runner.ts";
export type {
	Integration,
	IntegrationAction,
	IntegrationActionContext,
	IntegrationDefinition,
	IntegrationDefinitionConfig,
	IntegrationError,
	IntegrationErrorListener,
	IntegrationEventDescriptor,
	IntegrationEventPayload,
	IntegrationHandle,
	IntegrationOnboardContext,
	IntegrationOnboardUI,
	IntegrationRunContext,
	IntegrationRunContextOf,
	KeyValueStore,
	LoadedIntegrationConfig,
	LoadIntegrationsResult,
} from "./types.ts";
export { defineIntegration } from "./types.ts";
