// The session-playback hook. It fetches a `.jsonl` when the chat scrolls into view,
// reconstructs it with the ported loader (src/lib/session.ts), then replays it.
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
//
// Playback is self-timed: each frame is applied, then the driver waits that frame's own
// delay before the next, so a user's typing or an assistant's stream runs to its end before
// the next thing starts. Autoplay fires once via IntersectionObserver; play()/seek() are
// exposed so a later phase can drive playback by scroll.

import { useCallback, useEffect, useRef, useState } from "react";

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
			// Type the message into the composer (idle), send it, then the run starts.
			let acc = "";
			for (const token of streamTokens(getUserMessageText(message.content))) {
				acc += token;
				yield { type: "input", text: acc };
			}
			yield { type: "submit" };
			yield { type: "agent_start" };
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

// Fully-fold the replay: the completely revealed transcript (used for the initial/SSR
// state and available for a static, non-animated render).
export function sessionToBlocks(messages: AgentMessage[]): TranscriptBlock[] {
	let state = initialState();
	for (const event of replay(messages)) state = applyEvent(state, event);
	return state.blocks;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

// The pause (ms) after a frame is applied. Playback is self-timed: the driver applies a
// frame, waits this long, then applies the next — so each unit (the user typing, an
// assistant stream, a tool run) plays to its own end before the next thing starts, instead
// of sharing one global budget. User typing dwells longer so it is readable; the assistant
// streams faster. The small jitter keeps both from feeling mechanical.
function eventCost(event: Frame): number {
	switch (event.type) {
		case "input":
			return 62 + Math.random() * 48; // ~62-110ms per token: visible, human typing
		case "submit":
			return 340; // beat while the message "sends"
		case "message_update":
			return 16 + Math.random() * 14; // assistant streams faster than the user types
		case "message_start":
			return event.message.role === "user" ? 40 : 160;
		case "message_end":
			return event.message.role === "user" ? 220 : 260;
		case "tool_execution_start":
			return 220; // the tool spins up
		case "tool_execution_end":
			return 260; // read the result before moving on
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
// Hook
// ---------------------------------------------------------------------------

export interface UseSessionResult {
	ref: (node: Element | null) => void;
	blocks: TranscriptBlock[];
	busy: boolean;
	input: string;
	started: boolean;
	done: boolean;
	play: () => void;
	seek: (index: number) => void;
}

export function useSession(url: string): UseSessionResult {
	const [state, setState] = useState<TranscriptState>(initialState);
	const [started, setStarted] = useState(false);
	const [done, setDone] = useState(false);

	const eventsRef = useRef<Frame[] | null>(null);
	const cursorRef = useRef(0);
	const stateRef = useRef<TranscriptState>(state);
	const observerElRef = useRef<Element | null>(null);

	// Self-timed driver: apply a frame, wait its own delay (eventCost), apply the next. Each
	// unit therefore runs to completion before the next begins.
	const run = useCallback(async (signal: AbortSignal) => {
		const events = eventsRef.current;
		if (!events) return;
		let working = stateRef.current;
		for (let i = cursorRef.current; i < events.length; i++) {
			if (signal.aborted) return;
			const event = events[i]!;
			working = applyEvent(working, event);
			stateRef.current = working;
			cursorRef.current = i + 1;
			setState(working);
			await sleep(eventCost(event), signal);
		}
		if (!signal.aborted) setDone(true);
	}, []);

	// seek(index): recompute state by folding events[0..index]. Kept simple (fold from
	// scratch) so a later phase can drive playback by scroll position.
	const seek = useCallback((index: number) => {
		const events = eventsRef.current;
		if (!events) return;
		const clamped = Math.max(0, Math.min(index, events.length));
		let working = initialState();
		for (let i = 0; i < clamped; i++) working = applyEvent(working, events[i]!);
		cursorRef.current = clamped;
		stateRef.current = working;
		setState(working);
		setDone(clamped >= events.length);
	}, []);

	const beginPlayback = useCallback(
		async (signal: AbortSignal) => {
			try {
				const response = await fetch(url, { signal });
				if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
				const text = await response.text();
				if (signal.aborted) return;
				const context = loadSession(text, url);
				eventsRef.current = Array.from(replay(context.messages));
				cursorRef.current = 0;
				stateRef.current = initialState();
				await run(signal);
			} catch (error) {
				if (!signal.aborted) console.error(error);
			}
		},
		[url, run],
	);

	// Autoplay once when the chat scrolls into view.
	useEffect(() => {
		const element = observerElRef.current;
		if (!element || started) return;
		if (typeof IntersectionObserver === "undefined") {
			setStarted(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setStarted(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "0px 0px -20% 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [started]);

	useEffect(() => {
		if (!started) return;
		const controller = new AbortController();
		void beginPlayback(controller.signal);
		return () => controller.abort();
	}, [started, beginPlayback]);

	const play = useCallback(() => setStarted(true), []);

	const ref = useCallback((node: Element | null) => {
		observerElRef.current = node;
	}, []);

	return { ref, blocks: state.blocks, busy: state.busy, input: state.input, started, done, play, seek };
}
