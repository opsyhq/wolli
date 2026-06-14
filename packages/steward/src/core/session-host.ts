/**
 * Session host — owns building and swapping an agent's session/harness.
 *
 * Steward's minimal analogue of `@opsyhq/coding-agent`'s `AgentSessionRuntime`
 * (the "runtimeHost"). It is the single home for the session lifecycle: it
 * resolves the env, freezes the system prompt, wires the tools, and on
 * `newSession()` tears the current env down and builds a fresh harness. The
 * interactive mode holds a `SessionHost` and calls `newSession()` to swap in
 * place — required because the system prompt is frozen for a session's lifetime,
 * so a transition that must change the prompt (the birth instruction dropping at
 * commission) needs a new harness.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentHarness, ThinkingLevel } from "@opsyhq/agent";
import type { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getAgentDir } from "../config.ts";
import { type AgentConfig, loadAgentConfig } from "./agent-config.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { loadMemory } from "./memory.ts";
import { createAgentSession } from "./sdk.ts";
import { openAgentSession } from "./session.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
// pi's tools, vendored under tools/ (copied 1-1, see those files). memory is
// steward's own curated-notes tool. The rest — read/write/edit/ls/grep/find and
// bash — are wired exactly as pi wires them, with no overrides.
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "./tools/index.ts";
import { createMemoryTool } from "./tools/memory.ts";

export interface SessionHostOptions {
	name: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	authStorage: AuthStorage;
}

export class SessionHost {
	private readonly options: SessionHostOptions;
	private _harness?: AgentHarness;
	private _config?: AgentConfig;
	private env?: NodeExecutionEnv;

	constructor(options: SessionHostOptions) {
		this.options = options;
	}

	/** The live harness. Throws if accessed before `start()`. */
	get harness(): AgentHarness {
		if (!this._harness) throw new Error("SessionHost not started.");
		return this._harness;
	}

	/** The config the live harness was built from (re-read each build). */
	get config(): AgentConfig {
		if (!this._config) throw new Error("SessionHost not started.");
		return this._config;
	}

	/**
	 * The dir tools operate in — the agent's home dir, where SOUL/MEMORY/USER.md
	 * and workspace/ live. Mirrors `@opsyhq/coding-agent`'s `SessionManager.getCwd()`,
	 * which the interactive mode passes into each `ToolExecutionComponent` so its
	 * built-in renderers can reconstruct from cwd.
	 */
	getCwd(): string {
		return getAgentDir(this.options.name);
	}

	/** Build the first session. */
	async start(options: { fresh?: boolean } = {}): Promise<AgentHarness> {
		return this.build(options.fresh ?? false);
	}

	/** Tear down the current session and build a fresh one (e.g. after commissioning). */
	async newSession(): Promise<AgentHarness> {
		return this.build(true);
	}

	private async build(fresh: boolean): Promise<AgentHarness> {
		const { name, model, thinkingLevel, authStorage } = this.options;
		const previousEnv = this.env;

		// Re-read: commissionedAt may have changed since the previous harness.
		const config = loadAgentConfig(name);
		const { session, env } = await openAgentSession(name, { fresh });

		// Read curated files ONCE and freeze them into the prompt. Mid-session edits
		// (memory tool / file tools) persist to disk but only enter the prompt next session.
		const { soul, memory, user } = loadMemory(name);
		const systemPrompt = buildSystemPrompt({ config, soul, memory, user });

		// Tools operate in the agent's home dir, where SOUL/MEMORY/USER.md and the
		// workspace/ subdir live. memory is steward's curated-notes tool; the rest
		// are pi's read/write/edit/ls/grep/find plus bash, wired exactly as pi wires
		// them — bash uses pi's default local shell operations (it streams output
		// itself via the renderer's onUpdate), so there are no overrides.
		const agentDir = getAgentDir(name);
		const { harness } = await createAgentSession({
			env,
			session,
			model,
			systemPrompt,
			thinkingLevel,
			tools: [
				createMemoryTool(name),
				createReadTool(agentDir),
				createWriteTool(agentDir),
				createEditTool(agentDir),
				createLsTool(agentDir),
				createGrepTool(agentDir),
				createFindTool(agentDir),
				createBashTool(agentDir),
			],
			authStorage,
		});

		this._config = config;
		this._harness = harness;
		this.env = env;
		// Release the superseded session's env once the new one is live.
		await previousEnv?.cleanup();
		return harness;
	}

	/** Release the live session's env. Best-effort. */
	async cleanup(): Promise<void> {
		await this.env?.cleanup();
		this.env = undefined;
	}
}
