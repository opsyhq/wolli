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
import type { AgentConfig } from "./core/agent-config.ts";
import type { OnboardIntegrationResult } from "./core/integrations/onboarding.ts";
import type { ScopedModel } from "./core/model-resolver.ts";

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
	// Granular capability reads the agent detail page consumes, assembled from in-process
	// getters. Full-object reads keep the plain noun; trimmed info views take an `_info` verb.
	| { id?: string; type: "get_tool_info" }
	| { id?: string; type: "get_integration_info" }
	| { id?: string; type: "get_skills" }
	| { id?: string; type: "get_plugins" }
	| { id?: string; type: "get_context_info" }
	// Session-mutation helpers the TUI client drives (birth opener seed; resumed-message append).
	| { id?: string; type: "seed_assistant_message"; text: string }
	| { id?: string; type: "append_message"; message: AgentMessage }

	// Plugins — the daemon is the single writer: the CLI's mutating arms route here so the
	// install/onboard primitive runs in-process, then the daemon reloads itself (never stale).
	| { id?: string; type: "install_plugin"; source: string }
	| { id?: string; type: "remove_plugin"; source: string }
	| { id?: string; type: "update_plugins"; source?: string }
	| { id?: string; type: "onboard_plugin"; source: string }

	// Model / thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "get_available_models" }
	// Scoped models — `set_scoped_models` switches the session-only scope (daemon resolves the
	// patterns against its private registry); `set_enabled_models` persists the agent-tier shortlist.
	| { id?: string; type: "set_scoped_models"; enabledModelIds: string[] }
	| { id?: string; type: "set_enabled_models"; enabledModels?: string[] };

export type DaemonCommandType = DaemonCommand["type"];

// ============================================================================
// Responses (POST /control response body)
// ============================================================================

/**
 * One service's structured onboarding outcome. The `onboard_plugin` verb returns
 * `{ results: OnboardServiceResult[] }` so the client prints them (the daemon never logs).
 */
export interface OnboardServiceResult {
	service: string;
	status: OnboardIntegrationResult["status"];
	message?: string;
}

/** A generic success arm (`data` is the verb-specific payload) plus the shared error arm. */
export type DaemonResponse =
	| { id?: string; type: "response"; command: DaemonCommandType; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI (the round-trip the daemon-side extension runner drives)
// ============================================================================

/**
 * An extension-UI request, pushed to attach clients as an SSE frame (NOT an `AgentHarnessEvent`
 * — it bypasses the curated forwarded set and the replay ring). The four awaited dialogs
 * (`select`/`confirm`/`input`/`editor`) park a promise keyed by `id`; the client answers via
 * `POST /ui-response`. The five fire-and-forget methods carry no `id` correlation. All nine
 * `method` literals are camelCase.
 */
export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "setEditorText"; text: string };

/** A client's answer to an awaited `ExtensionUIRequest`, posted to `/ui-response`. */
export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Session state (get_state / hello snapshot)
// ============================================================================

/** The `get_state` / `hello` snapshot. */
export interface DaemonSessionState {
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	scopedModels: ScopedModel[];
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

/**
 * Scoped-model scope change. Host-originated (not a harness own-event) — the daemon broadcasts
 * it after `host.setScopedModels()` resolves, so attached clients refresh their cached scope.
 */
export interface ScopedModelsUpdateEvent {
	type: "scoped_models_update";
	scopedModels: ScopedModel[];
}

/** The harness events forwarded to attach clients. Internal own-events are dropped. */
export type DaemonEvent =
	| AgentEvent
	| QueueUpdateEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ScopedModelsUpdateEvent;

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
	// Host-originated daemon event
	"scoped_models_update",
]);
