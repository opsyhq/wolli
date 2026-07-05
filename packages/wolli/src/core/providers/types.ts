/**
 * Provider authoring types.
 *
 * One file under the agent home's `providers/` folder defines one provider: the default export
 * is the config, loaded at startup and registered with the model registry, independent of the
 * workflow engine. The provider name is the filename. Collapses the model registry's
 * structurally-equal `ProviderConfigInput` into the doc-rich `ProviderConfig` the extension
 * system authored; the extension type keeps backing `wolli.registerProvider` until Phase 5
 * deletes the extension system.
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthProviderInterface,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SourceInfo } from "../source-info.ts";

/** Configuration for a provider: one `defineProvider` default export per file under `providers/`. */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or leading !command. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/** Optional streamSimple handler for custom APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	oauth?: Omit<OAuthProviderInterface, "id">;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4-20250514"). */
	id: string;
	/** Display name (e.g., "Claude 4 Sonnet"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** API endpoint URL override for this model. */
	baseUrl?: string;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps wolli thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Cost per token (for tracking, can be 0). */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Define a provider. Identity at runtime; the config registers with the model registry at startup. */
export function defineProvider(config: ProviderConfig): ProviderConfig {
	return config;
}

/** A loaded provider module — mirror of `Tool`: the config plus its file identity and the name the filename yields. */
export interface Provider {
	name: string;
	config: ProviderConfig;
	sourceInfo: SourceInfo;
	path: string;
	resolvedPath: string;
}

/** Mirror of `LoadToolsResult`. */
export interface LoadProvidersResult {
	providers: Provider[];
	errors: Array<{ path: string; error: string }>;
}
