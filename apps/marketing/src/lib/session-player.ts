// Session-level playback for the demo rail: everything it takes to turn one `.jsonl`
// into a playing transcript. The pieces, top to bottom:
//
//   - `replay(messages)` emits the real AgentEvent stream in canonical order, streaming
//     assistant text by yielding message_update with a growing cumulative AssistantMessage
//     (as the agent loop does). Before each user message it also emits two small UI frames
//     — `input` (the composer text growing) then `submit` — so the demo types the user's
//     message into the input box and "sends" it. Like the real loop, each submitted prompt
//     opens a run (agent_start) that ends (agent_end) when the assistant's final message
//     completes — so `busy` is false while the user types. Event-delivered user messages
//     (`isEventMessage`: a "[github] ..."-style integration delivery, nobody at the
//     keyboard) skip the composer frames and just land.
//   - `applyEvent` mirrors InteractiveMode.handleEvent (interactive-mode.ts): a streaming
//     assistant block, a pendingTools map keyed by tool-call id, a busy flag, and the
//     composer `input` text.
//   - `SessionPlayer` (bottom) owns one session's lifecycle — load (fetched + cached),
//     play (the self-timed driver; each call restarts from the top, so replaying a
//     finished section is just calling it again), fold (instant full transcript) — and
//     is the sole owner of its idle/playing/done status and its abort controller.
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

// A user message delivered by an integration/workflow ("[github] Issue #912 opened...")
// rather than typed by the human. Replay lands it without composer frames; the chat
// renders it as an event bubble. The convention is the bracket tag the delivery prompt
// starts with — tag then a space, so a typed message opening with a markdown link
// ("[docs](...)") is not mistaken for one.
export function isEventMessage(text: string): boolean {
	return /^\[[\w-]+\] /.test(text);
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

// The successive cumulative states of a streaming string, growing 3-5 characters per
// step, so text streams like model tokens rather than typed words.
function streamText(text: string): string[] {
	const steps: string[] = [];
	let end = 0;
	while (end < text.length) {
		end += 3 + (steps.length % 3); // 3, 4, 5, 3, 4, 5...
		steps.push(text.slice(0, end));
	}
	return steps;
}

// The long string argument a tool call streams chunk by chunk so the block visibly
// builds up — only for tools whose renderer shows that arg in full (write's body,
// bash's title). Other tools render args as truncated JSON, where streaming would
// spend frames on changes nobody can see; their args land whole instead.
const STREAMED_ARGS: Record<string, string> = { write: "content", bash: "command" };

function streamedArgEntry(name: string, args: unknown): [string, string] | undefined {
	const key = STREAMED_ARGS[name];
	if (!key || typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value ? [key, value] : undefined;
}

// Yield cumulative AssistantMessages that grow text/thinking blocks and reveal toolCall
// blocks in order, growing each toolCall's long string arg the same way. message_update's
// message is the cumulative growing message. Elements of `revealed` are only ever
// replaced, never mutated, so a shallow copy per yield is enough — and settled blocks
// keep their identity across frames, which lets React bail out on them.
function* streamAssistant(message: AssistantMessage): Generator<AssistantMessage> {
	const revealed: Array<TextContent | ThinkingContent | ToolCall> = [];
	for (const block of message.content) {
		if (block.type === "text" || block.type === "thinking") {
			const key = block.type === "text" ? "text" : "thinking";
			const full = block.type === "text" ? block.text : block.thinking;
			const steps = streamText(full);
			if (steps.length === 0) {
				revealed.push(block);
				continue;
			}
			const index = revealed.length;
			for (const partial of steps) {
				revealed[index] = { ...block, [key]: partial } as TextContent | ThinkingContent;
				yield { ...message, content: [...revealed] };
			}
			revealed[index] = block;
		} else {
			const streamed = streamedArgEntry(block.name, block.arguments);
			if (!streamed) {
				revealed.push(block);
				yield { ...message, content: [...revealed] };
				continue;
			}
			// Reveal the call with its short args (the write's path, the tool title) at
			// once, then grow the long arg; the last step completes it.
			const [key, full] = streamed;
			const args = block.arguments as Record<string, unknown>;
			const index = revealed.length;
			for (const partial of ["", ...streamText(full)]) {
				revealed[index] = { ...block, arguments: { ...args, [key]: partial } };
				yield { ...message, content: [...revealed] };
			}
			revealed[index] = block;
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
			// would flash its hint there. An event delivery was never typed by anyone,
			// so it lands without the composer frames.
			const text = getUserMessageText(message.content);
			if (!isEventMessage(text)) {
				for (const partial of streamText(text)) {
					yield { type: "input", text: partial };
				}
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

// Fold the whole replay in one pass — the state after every frame has been applied.
function foldState(messages: AgentMessage[]): TranscriptState {
	let state = initialState();
	for (const frame of replay(messages)) state = applyEvent(state, frame);
	return state;
}

// Fully-fold the replay: the completely revealed transcript (used to fold skipped/done
// sections to their complete transcript without playing them).
export function sessionToBlocks(messages: AgentMessage[]): TranscriptBlock[] {
	return foldState(messages).blocks;
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
// of sharing one global budget. Frames are 3-5 char chunks (streamText): the user types
// them slowly, the assistant streams them fast; boundary beats (submit, tool start/end)
// give the eye time to land. The jitter keeps it from feeling mechanical.
function eventCost(event: Frame): number {
	switch (event.type) {
		case "input":
			return 45 + Math.random() * 35; // ~45-80ms per chunk: visible, human typing
		case "submit":
			return 420; // beat while the message "sends"
		case "message_update":
			return 12 + Math.random() * 12; // assistant streams much faster than the user types
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

// One player per session url; the sole owner of its status and abort controller. `play`
// is the self-timed driver (a repeat call replays from the top), `fold` reveals the
// complete transcript instantly, `stop` aborts the run. Knows nothing about other
// sessions, scroll, or React.
export class SessionPlayer {
	status: SessionPlayerStatus = "idle";
	/** Last emitted state — what the chat renders for this session. */
	snapshot: SessionSnapshot = IDLE_SNAPSHOT;

	private readonly url: string;
	/**
	 * The previous section's player when this session CONTINUES its transcript (the same
	 * session later in time): everything the predecessor already showed folds instantly
	 * and playback picks up from there. The continued file must extend the predecessor's
	 * messages verbatim — the demo generator produces both from one shared prefix.
	 */
	private readonly continues?: SessionPlayer;
	private messages: Promise<AgentMessage[]> | null = null;
	private controller: AbortController | null = null;

	constructor(url: string, continues?: SessionPlayer) {
		this.url = url;
		this.continues = continues;
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
	// Each call restarts from the top and aborts the player's previous run — a section
	// taking focus always plays from its start.
	async play(onChange: (snapshot: SessionSnapshot) => void): Promise<void> {
		this.stop();
		const controller = new AbortController();
		this.controller = controller;
		const signal = controller.signal;
		this.status = "playing";
		try {
			const messages = await this.load();
			// A continuing session folds everything its predecessor already showed —
			// however many messages that is — and picks up from there.
			const startAfter = this.continues ? (await this.continues.load()).length : 0;
			if (signal.aborted) return;
			let working = foldState(messages.slice(0, startAfter));
			this.emit({ blocks: working.blocks, busy: working.busy, input: working.input }, onChange);
			for (const frame of replay(messages.slice(startAfter))) {
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

	/** Abort the in-flight run, if any. The player keeps its last snapshot and status. */
	stop(): void {
		this.controller?.abort();
	}

	// Fold to the complete transcript without playing, aborting any in-flight run.
	async fold(onChange: (snapshot: SessionSnapshot) => void): Promise<void> {
		this.stop();
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
