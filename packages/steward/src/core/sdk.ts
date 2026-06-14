/**
 * Agent builder.
 *
 * Mirrors `@opsyhq/coding-agent`'s core/sdk.ts — same file, name, and result
 * shape (`createAgentSession` → `{ ... }`). The one deliberate divergence: this
 * constructs the engine's high-level `AgentHarness` (durable session tree built
 * in) instead of low-level `Agent` + the heavy `AgentSession` stack.
 *
 * The `systemPrompt` is passed in pre-built and frozen into a constant callback
 * here. `AgentHarness` re-invokes that callback every turn (see
 * `createTurnState`/`prepareNextTurn`), so capturing a constant string keeps the
 * prompt byte-identical for the whole session and the prefix cache warm.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentHarness, type AgentTool, type ExecutionEnv, type Session, type ThinkingLevel } from "@opsyhq/agent";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

export interface CreateAgentSessionOptions {
	env: ExecutionEnv;
	session: Session;
	model: Model<Api>;
	/** Pre-built system prompt, frozen for the lifetime of the session. */
	systemPrompt: string;
	tools?: AgentTool[];
	thinkingLevel?: ThinkingLevel;
	/** Shared credential store. Default: `AuthStorage.create()`. */
	authStorage?: AuthStorage;
}

export interface CreateAgentSessionResult {
	harness: AgentHarness;
}

/**
 * Resolve a provider API key from the shared credential store, then headers.
 *
 * Stands in for coding-agent's `ModelRegistry.getApiKeyAndHeaders`: `getApiKey`
 * checks runtime overrides → auth.json (api keys + OAuth, auto-refreshing tokens)
 * → env vars, so a Codex OAuth login or an `ANTHROPIC_API_KEY` both resolve. The
 * apiKey alone suffices — pi-ai's provider derives the account id and request
 * headers from it (e.g. the `openai-codex-responses` provider).
 */
async function getApiKeyAndHeaders(
	authStorage: AuthStorage,
	model: Model<Api>,
): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined> {
	const apiKey = await authStorage.getApiKey(model.provider);
	return apiKey ? { apiKey } : undefined;
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const authStorage = options.authStorage ?? AuthStorage.create();
	const harness = new AgentHarness({
		env: options.env,
		session: options.session,
		model: options.model,
		thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
		systemPrompt: () => options.systemPrompt,
		tools: options.tools,
		getApiKeyAndHeaders: (model) => getApiKeyAndHeaders(authStorage, model),
	});
	return { harness };
}
