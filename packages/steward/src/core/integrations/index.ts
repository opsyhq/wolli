/**
 * Integration subsystem: a bidirectional capability primitive (actions + events +
 * a long-running producer) defined in a per-agent `integrations/` folder and
 * consumed by extensions via `getIntegration`.
 */

export {
	createIntegrationRuntime,
	discoverAndLoadIntegrations,
	loadIntegrationFromFactory,
	loadIntegrations,
} from "./loader.ts";
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
	IntegrationRunContext,
	IntegrationRuntime,
	IntegrationRuntimeState,
	IntegrationsAPI,
	LoadIntegrationsResult,
} from "./types.ts";
