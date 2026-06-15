/**
 * SessionManager adapter (Tier 5 — steward-authored seam, NOT a 1-1 file port).
 *
 * Substrate-forced divergence. pi's `core/session-manager.ts` owns session
 * persistence (it reads/writes its own JSONL). In steward the engine
 * (`@opsyhq/agent`'s `Session` + `JsonlSessionRepo`) already owns that file. A
 * 1-1 port would write a *second* parallel JSONL and fight ownership. So this
 * adapter re-expresses pi's `SessionManager` **read** surface — the 13-method
 * *synchronous* `ReadonlySessionManager` the extension API was written against —
 * directly over the **same JSONL the engine writes**, and **delegates writes**
 * to the engine `Session`. The five types Tier-4 `extensions/types.ts` imports
 * from `../session-manager.ts` are re-exported here.
 *
 * Flagged divergences from pi's `session-manager.ts`:
 *  1. The class is an adapter over `Session`, not a self-owned JSONL manager.
 *  2. Leaf computation honors the engine's persisted `leaf`-redirect entries
 *     (`leafIdAfterEntry`); pi recomputed `leafId` as "last entry" in memory and
 *     never persisted a leaf entry. `leaf` entries are bookkeeping and are
 *     filtered out of the surfaced entry list (extensions keep pi's model).
 *  3. Write methods are **async** (they delegate to the engine `Session`, whose
 *     append is async) where pi's were sync-returning-string. The read contract
 *     (`ReadonlySessionManager`) is unaffected; only the write helpers differ.
 *  4. Reads are an mtime-cached file snapshot (the engine is the writer), so a
 *     just-appended entry becomes visible once the engine has flushed it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	JsonlSessionMetadata,
	LeafEntry,
	Session,
	SessionTreeEntry,
} from "@opsyhq/agent";

// The five names Tier-4 `extensions/types.ts` imports from "../session-manager.ts".
// SessionEntry/CompactionEntry/BranchSummaryEntry are the engine's structurally
// identical equivalents (re-aliased so import paths stay byte-identical to pi's).
export type { BranchSummaryEntry, CompactionEntry } from "@opsyhq/agent";
export type { SessionTreeEntry as SessionEntry } from "@opsyhq/agent";

/** Session header (first JSONL line). Mirrors pi's `SessionHeader`. */
export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

/** Tree node for `getTree()` — defensive copy of session structure (pi shape). */
export interface SessionTreeNode {
	entry: SessionTreeEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

interface SessionSnapshot {
	header: SessionHeader | null;
	entries: SessionTreeEntry[];
	byId: Map<string, SessionTreeEntry>;
	labelsById: Map<string, string>;
	labelTimestampsById: Map<string, string>;
	leafId: string | null;
}

/** Leaf after an entry: a `leaf` entry redirects the leaf, every other entry is its own leaf. */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? (entry as LeafEntry).targetId : entry.id;
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
	header: null,
	entries: [],
	byId: new Map(),
	labelsById: new Map(),
	labelTimestampsById: new Map(),
	leafId: null,
};

export class SessionManager {
	private readonly session: Session<JsonlSessionMetadata>;
	private readonly sessionFile: string;
	private readonly sessionDir: string;
	private readonly sessionId: string;
	private readonly cwd: string;
	private cache: { mtimeMs: number; snapshot: SessionSnapshot } | undefined;

	constructor(session: Session<JsonlSessionMetadata>, metadata: JsonlSessionMetadata) {
		this.session = session;
		this.sessionFile = metadata.path;
		this.sessionDir = dirname(metadata.path);
		this.sessionId = metadata.id;
		this.cwd = metadata.cwd;
	}

	/** Read + parse the engine's JSONL, mtime-cached. The engine is the writer. */
	private _load(): SessionSnapshot {
		if (!existsSync(this.sessionFile)) return EMPTY_SNAPSHOT;
		const mtimeMs = statSync(this.sessionFile).mtimeMs;
		if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.snapshot;

		const content = readFileSync(this.sessionFile, "utf8");
		const lines = content.split("\n");
		const snapshot: SessionSnapshot = {
			header: null,
			entries: [],
			byId: new Map(),
			labelsById: new Map(),
			labelTimestampsById: new Map(),
			leafId: null,
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line || !line.trim()) continue;
			let parsed: SessionHeader | SessionTreeEntry;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // skip malformed lines (matches pi's tolerant parser)
			}
			if (parsed.type === "session") {
				snapshot.header = parsed as SessionHeader;
				continue;
			}
			const entry = parsed as SessionTreeEntry;
			// Honor the engine's leaf redirects when tracking the active leaf...
			snapshot.leafId = leafIdAfterEntry(entry);
			// ...but keep leaf-bookkeeping entries off the surface extensions read.
			if (entry.type === "leaf") continue;
			snapshot.byId.set(entry.id, entry);
			snapshot.entries.push(entry);
			if (entry.type === "label") {
				if (entry.label) {
					snapshot.labelsById.set(entry.targetId, entry.label);
					snapshot.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					snapshot.labelsById.delete(entry.targetId);
					snapshot.labelTimestampsById.delete(entry.targetId);
				}
			}
		}

		this.cache = { mtimeMs, snapshot };
		return snapshot;
	}

	// =========================================================================
	// Read surface (ReadonlySessionManager) — vendored from pi, sync over JSONL
	// =========================================================================

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getLeafId(): string | null {
		return this._load().leafId;
	}

	getLeafEntry(): SessionTreeEntry | undefined {
		const { leafId, byId } = this._load();
		return leafId ? byId.get(leafId) : undefined;
	}

	getEntry(id: string): SessionTreeEntry | undefined {
		return this._load().byId.get(id);
	}

	/** Get all direct children of an entry. */
	getChildren(parentId: string): SessionTreeEntry[] {
		const children: SessionTreeEntry[] = [];
		for (const entry of this._load().byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		return this._load().labelsById.get(id);
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 */
	getBranch(fromId?: string): SessionTreeEntry[] {
		const { leafId, byId } = this._load();
		const path: SessionTreeEntry[] = [];
		const startId = fromId ?? leafId;
		let current = startId ? byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	}

	getHeader(): SessionHeader | null {
		return this._load().header;
	}

	/** Get all session entries (excludes header and leaf bookkeeping). Shallow copy. */
	getEntries(): SessionTreeEntry[] {
		return [...this._load().entries];
	}

	/**
	 * Get the session as a tree structure. A well-formed session has exactly one
	 * root (first entry with parentId === null). Orphaned entries are also roots.
	 */
	getTree(): SessionTreeNode[] {
		const { entries, labelsById, labelTimestampsById } = this._load();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			const label = labelsById.get(entry.id);
			const labelTimestamp = labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	getSessionName(): string | undefined {
		const entries = this._load().entries;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	// =========================================================================
	// Write surface — delegates to the engine Session (async; see flag #3)
	// =========================================================================

	appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.session.appendCustomEntry(customType, data);
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: Parameters<Session<JsonlSessionMetadata>["appendCustomMessageEntry"]>[1],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.session.appendCustomMessageEntry(customType, content, display, details);
	}

	appendSessionInfo(name: string): Promise<string> {
		return this.session.appendSessionName(name);
	}

	appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.session.appendLabel(targetId, label);
	}
}

/** Read-only view exposed to extensions via `ctx.sessionManager`. */
export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;
