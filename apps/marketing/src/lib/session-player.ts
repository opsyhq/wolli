// Session-level playback for the demo rail: everything it takes to turn one `.jsonl`
// into a playing transcript. The pieces, top to bottom:
//
//   - `replay(messages)` emits the real AgentEvent stream in canonical order, streaming
//     assistant text by yielding message_update with a growing cumulative AssistantMessage
//     (as the agent loop does). Before each user message it also emits two small UI frames
//     — `input` (the composer text growing) then `submit` — so the demo types the user's
//     message into the input box and "sends" it. Like the real loop, each submitted prompt
//     opens a run (agent_start) that ends (agent_end) when the assistant's final message
//     completes — so `busy` is false while the user types.
//   - `applyEvent` mirrors InteractiveMode.handleEvent (interactive-mode.ts): a streaming
//     assistant block, a pendingTools map keyed by tool-call id, a busy flag, and the
//     composer `input` text.
//   - `SessionPlayer` (bottom) owns one session's lifecycle — load (fetched + cached),
//     play (the self-timed driver), fold (instant full transcript) — and is the sole
//     owner of its idle/playing/done status.
//
// Playback is self-timed: each frame is applied, then the driver waits that frame's own
// delay before the next, so a user's typing or an assistant's stream runs to its end before
// the next thing starts. Orchestration across sessions (which one is active, the scroll
// frontier) lives with the rail in routes/index.tsx.

import type { AgentEvent, AgentMessage, AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@/lib/session";
import { loadSession } from "@/lib/session";

// ---------------------------------------------------------------------------
// Transcript state (the visible blocks the chat renders)
// ---------------------------------------------------------------------------

export type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
};

export interface UserBlock {
	kind: "user";
	key: string;
	text: string;
}

export interface AssistantBlock {
	kind: "assistant";
	key: string;
	message: AssistantMessage;
}

export interface ToolBlock {
	kind: "tool";
	key: string;
	toolCallId: string;
	name: string;
	args: unknown;
	result?: ToolResultLike;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
}

export type TranscriptBlock = UserBlock | AssistantBlock | ToolBlock;

// The replay stream is the real AgentEvent union plus two UI-only frames that drive the
// composer: `input` (typed text so far) and `submit` (clears it before the bubble lands).
type Frame = AgentEvent | { type: "input"; text: string } | { type: "submit" };

interface TranscriptState {
	blocks: TranscriptBlock[];
	busy: boolean;
	/** Text currently "typed" into the composer before a user message is sent. */
	input: string;
	streamingKey: string | null;
	pendingTools: Map<string, string>;
	seq: number;
}

function initialState(): TranscriptState {
	return { blocks: [], busy: false, input: "", streamingKey: null, pendingTools: new Map(), seq: 0 };
}

function getUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

// Replace the block with `key`, returning a new blocks array. Mirrors the way the TUI
// mutates a live component in place, but immutably so React re-renders.
function replaceBlock(
	blocks: TranscriptBlock[],
	key: string,
	update: (block: TranscriptBlock) => TranscriptBlock,
): TranscriptBlock[] {
	return blocks.map((block) => (block.key === key ? update(block) : block));
}

// ---------------------------------------------------------------------------
// Reducer: mirrors InteractiveMode.handleEvent (interactive-mode.ts)
// ---------------------------------------------------------------------------

function applyEvent(state: TranscriptState, event: Frame): TranscriptState {
	switch (event.type) {
		// Composer frames (demo-only): type into / clear the input box.
		case "input":
			return { ...state, input: event.text };
		case "submit":
			return { ...state, input: "" };

		case "agent_start":
			return { ...state, busy: true, pendingTools: new Map() };

		case "message_start": {
			if (event.message.role === "user") {
				const key = `b${state.seq}`;
				const block: UserBlock = { kind: "user", key, text: getUserMessageText(event.message.content) };
				return { ...state, blocks: [...state.blocks, block], seq: state.seq + 1 };
			}
			if (isAssistantMessage(event.message)) {
				// Open the streaming bubble (content is empty at message_start).
				const key = `b${state.seq}`;
				const block: AssistantBlock = { kind: "assistant", key, message: event.message };
				return { ...state, blocks: [...state.blocks, block], streamingKey: key, seq: state.seq + 1 };
			}
			return state;
		}

		case "message_update": {
			if (!state.streamingKey || !isAssistantMessage(event.message)) return state;
			return updateAssistantMessage(state, state.streamingKey, event.message);
		}

		case "message_end": {
			if (event.message.role === "user") return state;
			if (state.streamingKey && isAssistantMessage(event.message)) {
				return finalizeAssistantMessage(state, state.streamingKey, event.message);
			}
			return state;
		}

		case "tool_execution_start": {
			const existingKey = state.pendingTools.get(event.toolCallId);
			if (existingKey) {
				return {
					...state,
					blocks: replaceBlock(state.blocks, existingKey, (block) =>
						block.kind === "tool" ? { ...block, executionStarted: true } : block,
					),
				};
			}
			// Defensive: create the tool block if it was not seen during streaming.
			const key = `b${state.seq}`;
			const block: ToolBlock = {
				kind: "tool",
				key,
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: event.args,
				isPartial: true,
				executionStarted: true,
				argsComplete: false,
			};
			const pendingTools = new Map(state.pendingTools).set(event.toolCallId, key);
			return { ...state, blocks: [...state.blocks, block], pendingTools, seq: state.seq + 1 };
		}

		case "tool_execution_update": {
			const key = state.pendingTools.get(event.toolCallId);
			if (!key) return state;
			return {
				...state,
				blocks: replaceBlock(state.blocks, key, (block) =>
					block.kind === "tool"
						? { ...block, result: { ...event.partialResult, isError: false }, isPartial: true }
						: block,
				),
			};
		}

		case "tool_execution_end": {
			const key = state.pendingTools.get(event.toolCallId);
			if (!key) return state;
			const pendingTools = new Map(state.pendingTools);
			pendingTools.delete(event.toolCallId);
			return {
				...state,
				pendingTools,
				blocks: replaceBlock(state.blocks, key, (block) =>
					block.kind === "tool"
						? { ...block, result: { ...event.result, isError: event.isError }, isPartial: false }
						: block,
				),
			};
		}

		case "agent_end": {
			// A bubble still streaming here never got its message_end; handleEvent removes it.
			const blocks = state.streamingKey ? state.blocks.filter((b) => b.key !== state.streamingKey) : state.blocks;
			return { ...state, blocks, busy: false, streamingKey: null, pendingTools: new Map() };
		}

		default:
			return state;
	}
}

// message_update in handleEvent: re-render the streaming bubble from the cumulative
// message and open a tool block per toolCall content block, keyed by its id.
function updateAssistantMessage(
	state: TranscriptState,
	streamingKey: string,
	message: AssistantMessage,
): TranscriptState {
	let seq = state.seq;
	let blocks = replaceBlock(state.blocks, streamingKey, (block) =>
		block.kind === "assistant" ? { ...block, message } : block,
	);

	const pendingTools = new Map(state.pendingTools);
	for (const content of message.content) {
		if (content.type !== "toolCall") continue;
		const existingKey = pendingTools.get(content.id);
		if (!existingKey) {
			const toolKey = `b${seq}`;
			blocks = [
				...blocks,
				{
					kind: "tool",
					key: toolKey,
					toolCallId: content.id,
					name: content.name,
					args: content.arguments,
					isPartial: true,
					executionStarted: false,
					argsComplete: false,
				},
			];
			pendingTools.set(content.id, toolKey);
			seq += 1;
		} else {
			blocks = replaceBlock(blocks, existingKey, (block) =>
				block.kind === "tool" ? { ...block, args: content.arguments } : block,
			);
		}
	}

	return { ...state, blocks, pendingTools, seq };
}

// message_end in handleEvent: commit the final content (the bubble stays and renders the
// error/abort notice itself), settle pending tools, and close the streaming bubble.
function finalizeAssistantMessage(
	state: TranscriptState,
	streamingKey: string,
	message: AssistantMessage,
): TranscriptState {
	if (message.stopReason === "aborted") {
		message = { ...message, errorMessage: "Operation aborted" };
	}
	let blocks = replaceBlock(state.blocks, streamingKey, (block) =>
		block.kind === "assistant" ? { ...block, message } : block,
	);

	if (message.stopReason === "aborted" || message.stopReason === "error") {
		// Settle any pending tools as errored.
		const errorText = message.errorMessage || "Error";
		for (const key of state.pendingTools.values()) {
			blocks = replaceBlock(blocks, key, (block) =>
				block.kind === "tool"
					? { ...block, result: { content: [{ type: "text", text: errorText }], isError: true }, isPartial: false }
					: block,
			);
		}
		return { ...state, blocks, streamingKey: null, pendingTools: new Map() };
	}

	// Args are now complete for tools opened during streaming.
	for (const key of state.pendingTools.values()) {
		blocks = replaceBlock(blocks, key, (block) => (block.kind === "tool" ? { ...block, argsComplete: true } : block));
	}
	return { ...state, blocks, streamingKey: null };
}

// ---------------------------------------------------------------------------
// Replay: AgentMessage[] -> frame stream (canonical order)
// ---------------------------------------------------------------------------

// Split text into small tokens (word + trailing whitespace) so text streams in naturally.
function streamTokens(text: string): string[] {
	return text.match(/\s*\S+|\s+/g) ?? [];
}

// Yield cumulative AssistantMessages that grow text/thinking blocks and reveal toolCall
// blocks in order. message_update.message is the cumulative growing message.
function* streamAssistant(message: AssistantMessage): Generator<AssistantMessage> {
	const revealed: Array<TextContent | ThinkingContent | ToolCall> = [];
	for (const block of message.content) {
		if (block.type === "text" || block.type === "thinking") {
			const key = block.type === "text" ? "text" : "thinking";
			const full = block.type === "text" ? block.text : block.thinking;
			let acc = "";
			const tokens = streamTokens(full);
			if (tokens.length === 0) {
				revealed.push(block);
				continue;
			}
			const index = revealed.length;
			revealed.push({ ...block, [key]: "" } as TextContent | ThinkingContent);
			for (const token of tokens) {
				acc += token;
				revealed[index] = { ...block, [key]: acc } as TextContent | ThinkingContent;
				yield { ...message, content: revealed.map((c) => ({ ...c })) };
			}
			revealed[index] = block;
		} else {
			revealed.push(block);
			yield { ...message, content: revealed.map((c) => ({ ...c })) };
		}
	}
}

function* replay(messages: AgentMessage[]): Generator<Frame> {
	// Tool-call args live on the assistant message; look them up when the matching
	// toolResult message is replayed.
	const toolCallsById = new Map<string, ToolCall>();
	let running = false;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "user") {
			// Type the message into the composer (idle), then the run opens and the
			// message "sends". agent_start comes BEFORE submit so the transcript is
			// never in the fully-idle state (empty blocks, empty input, not busy)
			// between the composer clearing and the user bubble landing — the chat
			// would flash its hint there.
			let acc = "";
			for (const token of streamTokens(getUserMessageText(message.content))) {
				acc += token;
				yield { type: "input", text: acc };
			}
			yield { type: "agent_start" };
			yield { type: "submit" };
			running = true;
			yield { type: "message_start", message };
			yield { type: "message_end", message };
		} else if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") toolCallsById.set(content.id, content);
			}
			yield { type: "message_start", message: { ...message, content: [] } };
			for (const partial of streamAssistant(message)) {
				yield {
					type: "message_update",
					message: partial,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial },
				};
			}
			yield { type: "message_end", message };
		} else if (message.role === "toolResult") {
			const call = toolCallsById.get(message.toolCallId);
			yield {
				type: "tool_execution_start",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				args: call?.arguments,
			};
			yield {
				type: "tool_execution_end",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				result: { content: message.content, details: message.details },
				isError: message.isError,
			};
		}

		// The turn ends when the assistant's message is the run's last work — nothing
		// follows but the next user prompt (or the end of the session).
		const next = messages[i + 1];
		if (running && message.role === "assistant" && (!next || next.role === "user")) {
			yield { type: "agent_end", messages };
			running = false;
		}
	}

	// A session cut off mid-run (e.g. ending on a tool result) still closes its run.
	if (running) yield { type: "agent_end", messages };
}

// Fully-fold the replay: the completely revealed transcript (used to fold skipped/done
// sections to their complete transcript without playing them).
export function sessionToBlocks(messages: AgentMessage[]): TranscriptBlock[] {
	let state = initialState();
	for (const event of replay(messages)) state = applyEvent(state, event);
	return state.blocks;
}

// ---------------------------------------------------------------------------
// File derivation (the tree is disk truth: what the transcripts actually wrote)
// ---------------------------------------------------------------------------

// The `path` arg of a write tool block, when it is a real string (WriteToolInput).
function writePath(block: ToolBlock): string | undefined {
	const path = (block.args as { path?: unknown } | undefined)?.path;
	return typeof path === "string" ? path : undefined;
}

// Files a session actually created: completed, non-error `write` blocks -> args.path
// (WriteToolInput), deduped in first-write order. Works on live and sessionToBlocks-folded
// blocks, so the tree accumulates across sessions.
export function writtenFiles(blocks: TranscriptBlock[]): string[] {
	const paths: string[] = [];
	for (const block of blocks) {
		if (block.kind !== "tool" || block.name !== "write") continue;
		if (block.isPartial || !block.result || block.result.isError) continue;
		const path = writePath(block);
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

// The path of an in-flight or just-completed non-error write — drives FileTree's
// `currentFile` for the ACTIVE session only.
export function activeWriteFile(blocks: TranscriptBlock[]): string | undefined {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (block.kind !== "tool" || block.name !== "write") continue;
		if (block.result?.isError) continue;
		return writePath(block);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

// The pause (ms) after a frame is applied. Playback is self-timed: the driver applies a
// frame, waits this long, then applies the next — so each unit (the user typing, an
// assistant stream, a tool run) plays to its own end before the next thing starts, instead
// of sharing one global budget. User typing dwells longer so it is readable; the assistant
// streams faster. The small jitter keeps both from feeling mechanical. Tuned for the rail's
// short "mini preview" sessions: a deliberate, watchable pace rather than a quick skim.
function eventCost(event: Frame): number {
	switch (event.type) {
		case "input":
			return 75 + Math.random() * 55; // ~75-130ms per token: visible, human typing
		case "submit":
			return 420; // beat while the message "sends"
		case "message_update":
			return 26 + Math.random() * 18; // assistant streams faster than the user types
		case "message_start":
			return event.message.role === "user" ? 40 : 240;
		case "message_end":
			return event.message.role === "user" ? 260 : 420;
		case "tool_execution_start":
			return 480; // the tool spins up
		case "tool_execution_end":
			return 600; // read the result before moving on
		default:
			return 0;
	}
}

// Resolve after `ms`, or immediately if the run is aborted mid-wait.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const id = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(id);
				resolve();
			},
			{ once: true },
		);
	});
}

// ---------------------------------------------------------------------------
// SessionPlayer: one session's lifecycle
// ---------------------------------------------------------------------------

export type SessionPlayerStatus = "idle" | "playing" | "done";

export interface SessionSnapshot {
	blocks: TranscriptBlock[];
	busy: boolean;
	input: string;
}

const IDLE_SNAPSHOT: SessionSnapshot = { blocks: [], busy: false, input: "" };

// One player per session url; the sole owner of its status. `play` is the self-timed
// driver, `fold` reveals the complete transcript instantly, `pause`/`resume` freeze the
// driver between frames. Knows nothing about other sessions, scroll, or React.
export class SessionPlayer {
	status: SessionPlayerStatus = "idle";
	/** Last emitted state — what the chat renders for this session. */
	snapshot: SessionSnapshot = IDLE_SNAPSHOT;

	private readonly url: string;
	private messages: Promise<AgentMessage[]> | null = null;
	private paused = false;
	private resumeResolvers: Array<() => void> = [];

	constructor(url: string) {
		this.url = url;
	}

	// Fetch + reconstruct, cached on the instance. Evicts on rejection so a transient
	// failure (e.g. flaky network during the mount prefetch) is retried by the next
	// caller instead of bricking the session forever.
	load(): Promise<AgentMessage[]> {
		if (!this.messages) {
			const promise = fetch(this.url)
				.then((response) => {
					if (!response.ok) throw new Error(`Failed to load ${this.url}: ${response.status}`);
					return response.text();
				})
				.then((text) => loadSession(text, this.url).messages);
			this.messages = promise;
			promise.catch(() => {
				this.messages = null;
			});
		}
		return this.messages;
	}

	// Self-timed driver: apply a frame, wait its own delay (eventCost), apply the next.
	// A pause holds the loop between frames until resume; an abort returns without
	// writes — the aborting caller folds the player itself.
	async play(onChange: (snapshot: SessionSnapshot) => void, signal: AbortSignal): Promise<void> {
		this.status = "playing";
		try {
			const messages = await this.load();
			if (signal.aborted) return;
			let working = initialState();
			for (const frame of replay(messages)) {
				await this.waitWhilePaused(signal);
				if (signal.aborted) return;
				working = applyEvent(working, frame);
				this.emit({ blocks: working.blocks, busy: working.busy, input: working.input }, onChange);
				await sleep(eventCost(frame), signal);
			}
			if (signal.aborted) return;
			this.status = "done";
			this.emit({ blocks: working.blocks, busy: false, input: "" }, onChange);
		} catch (error) {
			if (!signal.aborted) console.error(error);
		}
	}

	/** Freeze the driver between frames (the section scrolled out of view). No-op unless playing. */
	pause(): void {
		if (this.status === "playing") this.paused = true;
	}

	/** Let a paused driver continue from exactly where it froze. */
	resume(): void {
		this.paused = false;
		for (const resolve of this.resumeResolvers.splice(0)) resolve();
	}

	// Resolves immediately when not paused; otherwise on resume() or abort.
	private waitWhilePaused(signal: AbortSignal): Promise<void> {
		if (!this.paused || signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			this.resumeResolvers.push(resolve);
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	}

	// Fold to the complete transcript without playing.
	async fold(onChange: (snapshot: SessionSnapshot) => void): Promise<void> {
		this.status = "done";
		try {
			const messages = await this.load();
			this.emit({ blocks: sessionToBlocks(messages), busy: false, input: "" }, onChange);
		} catch (error) {
			console.error(error);
		}
	}

	private emit(snapshot: SessionSnapshot, onChange: (snapshot: SessionSnapshot) => void): void {
		this.snapshot = snapshot;
		onChange(snapshot);
	}
}
