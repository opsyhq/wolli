/**
 * Per-agent session open/resume.
 *
 * A minimal session manager: the engine's `JsonlSessionRepo` already provides the
 * durable, append-only session tree. Sessions are keyed by AGENT, not by the
 * user's cwd (see the key-by-agent note below).
 */

import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage, MessageEntry } from "@opsyhq/agent";
import { type JsonlSessionMetadata, JsonlSessionRepo, type Session } from "@opsyhq/agent";
import { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getSessionsDir, getWorkspaceDir } from "../config.ts";
import type { DaemonSessionInfo } from "../types.ts";

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

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: MessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(
	session: Session<JsonlSessionMetadata>,
	metadata: JsonlSessionMetadata,
): Promise<DaemonSessionInfo> {
	const entries = await session.getEntries();
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let name: string | undefined;
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		// Extract session name (use latest, including explicit clears)
		if (entry.type === "session_info") {
			name = entry.name?.trim() || undefined;
		}

		if (entry.type !== "message") continue;
		messageCount++;

		const activityTime = getMessageActivityTime(entry);
		if (typeof activityTime === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
		}

		const message = entry.message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const textContent = extractTextContent(message);
		if (!textContent) continue;

		allMessages.push(textContent);
		if (!firstMessage && message.role === "user") {
			firstMessage = textContent;
		}
	}

	const modified =
		typeof lastActivityTime === "number" && lastActivityTime > 0
			? new Date(lastActivityTime)
			: new Date(metadata.createdAt);

	return {
		path: metadata.path,
		id: metadata.id,
		cwd: metadata.cwd,
		name,
		parentSessionPath: metadata.parentSessionPath,
		created: metadata.createdAt,
		modified: modified.toISOString(),
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

/** Rich session list for the resume selector — opens every session, so it backs `/sessions/detail`, not the hot snapshot. */
export async function listAgentSessionsDetail(name: string): Promise<DaemonSessionInfo[]> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	const infos: DaemonSessionInfo[] = [];
	for (const metadata of metadatas) {
		try {
			infos.push(await buildSessionInfo(await repo.open(metadata), metadata));
		} catch {
			// Skip an unreadable session rather than fail the whole list (coding-agent filters such nulls out).
		}
	}
	return infos;
}

/** Rename a stored session by id — appends a `session_info` entry, the same primitive a live session uses. */
export async function renameAgentSession(name: string, id: string, sessionName: string): Promise<void> {
	const { session } = await openAgentSession(name, { id });
	await session.appendSessionName(sessionName);
}

/** Delete a stored session's JSONL file by id. Throws when no session matches. */
export async function deleteAgentSession(name: string, id: string): Promise<void> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	const match = metadatas.find((metadata) => metadata.id === id);
	if (!match) throw new Error(`No session "${id}" for agent "${name}"`);
	await repo.delete(match);
}
