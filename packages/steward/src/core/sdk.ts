/**
 * Agent builder. Constructs the high-level `AgentHarness` (durable session tree
 * built in) from a pre-built system prompt, model, tools, and resources.
 *
 * The `systemPrompt` is passed in pre-built and frozen into a constant callback
 * here. `AgentHarness` re-invokes that callback every turn, so capturing a
 * constant string keeps the prompt byte-identical for the whole session and the
 * prefix cache warm.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	type AgentHarnessResources,
	type AgentTool,
	type ExecutionEnv,
	type Session,
	type ThinkingLevel,
} from "@opsyhq/agent";
import type { AgentRuntime, AgentSession } from "./agent-runtime.ts";
import type { AgentSettingsManager } from "./agent-settings-manager.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { SessionInfo } from "./session.ts";

export interface CreateAgentSessionOptions {
	env: ExecutionEnv;
	session: Session;
	model: Model<Api>;
	/** Pre-built system prompt, frozen for the lifetime of the session. */
	systemPrompt: string;
	tools?: AgentTool[];
	thinkingLevel?: ThinkingLevel;
	/**
	 * Skills + prompt templates exposed to the harness for explicit invocation
	 * (`harness.skill()` / `harness.promptFromTemplate()`). Pre-mapped into the
	 * harness shapes by the caller.
	 */
	resources?: AgentHarnessResources;
	/** Model registry that resolves request-time auth (api keys + per-model/provider headers). */
	modelRegistry: ModelRegistry;
	/** Settings manager, read for provider-attribution headers. */
	settingsManager: AgentSettingsManager;
	/** Session id, threaded into provider-attribution session headers. */
	sessionId: string;
}

export interface CreateAgentSessionResult {
	harness: AgentHarness;
}

/**
 * Resolve request-time auth + headers through the `ModelRegistry`, then merge in
 * provider-attribution headers.
 *
 * Routing through `ModelRegistry.getApiKeyAndHeaders` (rather than reading the
 * api key straight off `AuthStorage`) is what carries custom `models.json` keys,
 * per-model/provider headers, and `Authorization: Bearer` auth. The harness
 * callback contract is `apiKey: string`, so a keyless (header-only) provider is
 * rejected here — no steward provider is keyless today.
 */
async function getApiKeyAndHeaders(
	modelRegistry: ModelRegistry,
	settingsManager: AgentSettingsManager,
	sessionId: string,
	model: Model<Api>,
): Promise<{ apiKey: string; headers?: Record<string, string> }> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for "${model.provider}"`);
	return {
		apiKey: auth.apiKey,
		headers: mergeProviderAttributionHeaders(model, settingsManager, sessionId, auth.headers),
	};
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const { modelRegistry, settingsManager, sessionId } = options;
	const harness = new AgentHarness({
		env: options.env,
		session: options.session,
		model: options.model,
		thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
		systemPrompt: () => options.systemPrompt,
		tools: options.tools,
		resources: options.resources,
		getApiKeyAndHeaders: (model) => getApiKeyAndHeaders(modelRegistry, settingsManager, sessionId, model),
	});
	return { harness };
}

/**
 * The public, in-process agent façade — the narrow handle an extension drives its agent
 * through. It wraps the internal `AgentRuntime` and exposes only session-level verbs; runtime
 * administration (auth, reload, registry, cleanup) stays internal. A future embedding/remote
 * caller uses this same surface.
 *
 * The runtime holds N resident sessions keyed by id: `getSession(id)` returns one (or undefined
 * when not resident), `createSession()` adds a fresh one, and `openSession(id)` rehydrates a stored
 * session.
 */
export class Agent {
	private readonly runtime: AgentRuntime;

	constructor(runtime: AgentRuntime) {
		this.runtime = runtime;
	}

	/** A resident session by id, or undefined. Find-only — never rehydrates. */
	getSession(id: string): AgentSession | undefined {
		return this.runtime.getSession(id);
	}

	/** Start a fresh session (new stored session) and make it resident. Additive. */
	createSession(): Promise<AgentSession> {
		return this.runtime.createSession();
	}

	/** Rehydrate a stored session by id into the resident map. */
	openSession(id: string): Promise<AgentSession> {
		return this.runtime.openSession(id);
	}

	/** Stored sessions for this agent (newest first) — the ids `openSession` accepts. */
	listSessions(): Promise<SessionInfo[]> {
		return this.runtime.listSessions();
	}
}
