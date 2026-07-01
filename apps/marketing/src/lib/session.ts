// Session building block: a faithful, filesystem-free port of wolli's JSONL session
// loader. The parsing/reconstruction functions below are copied verbatim (names and
// logic preserved) from the real wolli sources so the browser reconstructs a session
// exactly like the agent does:
//   - parseHeaderLine / parseEntryLine / leafIdAfterEntry  -> jsonl-storage.ts
//   - getPathToRoot                                        -> JsonlSessionStorage#getPathToRoot
//   - buildSessionContext                                  -> core session.ts
//   - createCustomMessage / createBranchSummaryMessage / createCompactionSummaryMessage -> harness/messages.ts
//
// Only `import type` is used for wolli/pi-ai code, so nothing from the Node agent
// runtime ends up in the client bundle. The one intentional deviation from the
// sources is that the wolli `SessionError` class (which lives in the Node-coupled
// agent barrel) is replaced by plain `Error`s carrying the same messages.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentMessage,
	BranchSummaryMessage,
	CompactionEntry,
	CompactionSummaryMessage,
	CustomMessage,
	SessionContext,
	SessionTreeEntry,
} from "@opsyhq/agent";

export type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
// Re-export the real types so the rest of the app builds on wolli's data model.
export type {
	AgentEvent,
	AgentMessage,
	SessionContext,
	SessionTreeEntry,
} from "@opsyhq/agent";

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`Invalid JSONL session file ${filePath}: first line is not a valid session header`);
	}
	if (!isRecord(parsed))
		throw new Error(`Invalid JSONL session file ${filePath}: first line is not a valid session header`);
	if (parsed.type !== "session")
		throw new Error(`Invalid JSONL session file ${filePath}: first line is not a valid session header`);
	if (parsed.version !== 3) throw new Error(`Invalid JSONL session file ${filePath}: unsupported session version`);
	if (typeof parsed.id !== "string" || !parsed.id)
		throw new Error(`Invalid JSONL session file ${filePath}: session header is missing id`);
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw new Error(`Invalid JSONL session file ${filePath}: session header is missing timestamp`);
	}
	if (typeof parsed.cwd !== "string" || !parsed.cwd)
		throw new Error(`Invalid JSONL session file ${filePath}: session header is missing cwd`);
	if (parsed.parentSession !== undefined && typeof parsed.parentSession !== "string") {
		throw new Error(`Invalid JSONL session file ${filePath}: session header parentSession must be a string`);
	}
	return {
		type: "session",
		version: 3,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: parsed.cwd,
		parentSession: parsed.parentSession,
	};
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} is not valid JSON`);
	}
	if (!isRecord(parsed))
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} is not a valid session entry`);
	if (typeof parsed.type !== "string")
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing entry type`);
	if (typeof parsed.id !== "string" || !parsed.id)
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing entry id`);
	if (parsed.parentId !== null && typeof parsed.parentId !== "string") {
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} has invalid parentId`);
	}
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing timestamp`);
	}
	if (parsed.type === "leaf" && parsed.targetId !== null && typeof parsed.targetId !== "string") {
		throw new Error(`Invalid JSONL session file ${filePath}: line ${lineNumber} has invalid targetId`);
	}
	return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

// Ported from JsonlSessionStorage#getPathToRoot; walks parentId links, unshifting so
// the result is ordered root -> leaf.
function getPathToRoot(byId: Map<string, SessionTreeEntry>, leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const path: SessionTreeEntry[] = [];
	let current = byId.get(leafId);
	if (!current) throw new Error(`Entry ${leafId} not found`);
	while (current) {
		path.unshift(current);
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) throw new Error(`Entry ${current.parentId} not found`);
		current = parent;
	}
	return path;
}

// Ported verbatim from harness/messages.ts.
function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

// Ported verbatim from core session.ts:23-81.
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionTreeEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message as AgentMessage);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(
					entry.customType,
					entry.content as string | (TextContent | ImageContent)[],
					entry.display,
					entry.details,
					entry.timestamp,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
		const compactionIdx = pathEntries.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = pathEntries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(entry);
		}
		for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
			appendMessage(pathEntries[i]!);
		}
	} else {
		for (const entry of pathEntries) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model, activeToolNames };
}

// Top-level loader: JSONL text -> reconstructed SessionContext. Mirrors
// loadJsonlStorage + getLeafId + getPathToRoot + buildSessionContext.
export function loadSession(text: string, filePath = "session"): SessionContext {
	const lines = text.split("\n").filter((line) => line.trim());
	if (lines.length === 0) {
		throw new Error(`Invalid JSONL session file ${filePath}: missing session header`);
	}

	parseHeaderLine(lines[0]!, filePath);

	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return buildSessionContext(getPathToRoot(byId, leafId));
}
