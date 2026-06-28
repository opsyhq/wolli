/**
 * Per-agent session open/resume.
 *
 * A minimal session manager: the engine's `JsonlSessionRepo` already provides the
 * durable, append-only session tree. Sessions are keyed by AGENT, not by the
 * user's cwd (see the key-by-agent note below).
 */

import { type JsonlSessionMetadata, JsonlSessionRepo, type Session } from "@opsyhq/agent";
import { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getSessionsDir, getWorkspaceDir } from "../config.ts";

export interface OpenAgentSessionOptions {
	/** Start a fresh session instead of resuming the latest. */
	fresh?: boolean;
	/** Resume a specific stored session by id instead of the latest. Ignored when `fresh` is set. */
	id?: string;
}

export interface OpenAgentSessionResult {
	repo: JsonlSessionRepo;
	session: Session<JsonlSessionMetadata>;
	env: NodeExecutionEnv;
	cwd: string;
}

/** One stored session for an agent — the `id` is what `openAgentSession({ id })` / `listSessions` use. */
export interface SessionInfo {
	id: string;
	createdAt: string;
	/** The session's folded tags. Populated by `findSessions`; `{}` from the plain `listSessions` listing. */
	tags: Record<string, string>;
}

export async function openAgentSession(
	name: string,
	options: OpenAgentSessionOptions = {},
): Promise<OpenAgentSessionResult> {
	// Key-by-agent: always use the agent's own workspace as cwd, so the repo's
	// encodeCwd() resolves to one constant subdir per agent — sessions never
	// scatter by whatever directory the user happened to run `wolli` from.
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });

	// Resume a specific stored session by id, matched off the repo's listing.
	if (options.id) {
		const existing = await repo.list({ cwd });
		const match = existing.find((metadata) => metadata.id === options.id);
		if (!match) throw new Error(`No session "${options.id}" for agent "${name}"`);
		return { repo, session: await repo.open(match), env, cwd };
	}

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

/** Stored sessions for an agent, as `repo.list` returns them (newest first). */
export async function listAgentSessions(name: string): Promise<SessionInfo[]> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	return metadatas.map((metadata) => ({ id: metadata.id, createdAt: metadata.createdAt, tags: {} }));
}
