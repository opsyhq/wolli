/**
 * Per-agent session open/resume.
 *
 * Analogous to coding-agent's core/session-manager.ts (SessionManager), but
 * minimal: the engine's `JsonlSessionRepo` already provides the durable,
 * append-only session tree. Sessions are keyed by AGENT, not by the user's cwd
 * (see the key-by-agent note below).
 */

import { type JsonlSessionMetadata, JsonlSessionRepo, type Session } from "@opsyhq/agent";
import { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getSessionsDir, getWorkspaceDir } from "../config.ts";

export interface OpenAgentSessionOptions {
	/** Start a fresh session instead of resuming the latest. */
	fresh?: boolean;
}

export interface OpenAgentSessionResult {
	repo: JsonlSessionRepo;
	session: Session<JsonlSessionMetadata>;
	env: NodeExecutionEnv;
	cwd: string;
}

export async function openAgentSession(
	name: string,
	options: OpenAgentSessionOptions = {},
): Promise<OpenAgentSessionResult> {
	// Key-by-agent: always use the agent's own workspace as cwd, so the repo's
	// encodeCwd() resolves to one constant subdir per agent — sessions never
	// scatter by whatever directory the user happened to run `steward` from.
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });

	if (!options.fresh) {
		const existing = await repo.list({ cwd });
		if (existing.length > 0) {
			const session = await repo.open(existing[0]);
			return { repo, session, env, cwd };
		}
	}

	const session = await repo.create({ cwd });
	return { repo, session, env, cwd };
}
