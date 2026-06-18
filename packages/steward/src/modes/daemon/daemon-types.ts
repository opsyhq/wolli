/**
 * Daemon protocol types.
 *
 * Commands arrive as a JSON body on `POST /control`; the response is that request's JSON
 * body. Events stream out of `GET /events` as SSE — a curated subset of the harness's event
 * surface (the `AgentEvent` stream plus queue/model/thinking updates), never the own-events.
 */

import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	AgentMessage,
	ModelUpdateEvent,
	QueueUpdateEvent,
	ThinkingLevel,
	ThinkingLevelUpdateEvent,
} from "@opsyhq/agent";
import type { AgentConfig } from "../../core/agent-config.ts";

// ============================================================================
// Commands (POST /control body)
// ============================================================================

export type DaemonCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "wait_for_idle" }
	| { id?: string; type: "clear_queue" }
	// `reason` distinguishes a plain reset ("new") from a post-deploy swap ("deploy"); the
	// deploy verb (Item 6) depends on it. Absent → the daemon defaults to "new".
	| { id?: string; type: "new_session"; reason?: "deploy" | "new" }
	| { id?: string; type: "reload" }
	// The single post-confirm deploy commit: flip the latch, install the OS service, swap to a
	// fresh deployed session. Returns the fresh snapshot (config now reads as deployed).
	| { id?: string; type: "deploy" }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" }
	// Read-only views the TUI client needs that map 1:1 onto existing host methods.
	| { id?: string; type: "get_entries" }
	| { id?: string; type: "get_resource_summary" }
	// Session-mutation helpers the TUI client drives (birth opener seed; resumed-message append).
	| { id?: string; type: "seed_assistant_message"; text: string }
	| { id?: string; type: "append_message"; message: AgentMessage }

	// Model / thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_model"; provider: string; modelId: string };

export type DaemonCommandType = DaemonCommand["type"];

// ============================================================================
// Responses (POST /control response body)
// ============================================================================

/** A generic success arm (`data` is the verb-specific payload) plus the shared error arm. */
export type DaemonResponse =
	| { id?: string; type: "response"; command: DaemonCommandType; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Session state (get_state / hello snapshot)
// ============================================================================

/** The `get_state` / `hello` snapshot. */
export interface DaemonSessionState {
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	messageCount: number;
	pendingMessageCount: number;
	/** The agent's config (mirrors `host.config`) — the client reads it without a round-trip. */
	config: AgentConfig;
	/** The agent's home dir (mirrors `host.getCwd()`) — built-in tool renderers reconstruct from it. */
	cwd: string;
}

// ============================================================================
// Events (GET /events SSE) — the curated forwarded union
// ============================================================================

/** The harness events forwarded to attach clients. Internal own-events are dropped. */
export type DaemonEvent = AgentEvent | QueueUpdateEvent | ModelUpdateEvent | ThinkingLevelUpdateEvent;

/**
 * Runtime allowlist of forwarded event `type` strings — the broadcaster filter. Anything
 * not in this set (save_point, settled, abort, session_*, tools_update, before_*, …) stays
 * internal to the daemon.
 */
export const FORWARDED_EVENT_TYPES: ReadonlySet<DaemonEvent["type"]> = new Set([
	// AgentEvent lifecycle
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	// Curated own-events
	"queue_update",
	"model_update",
	"thinking_level_update",
]);
