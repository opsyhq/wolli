/**
 * Daemon protocol types.
 *
 * The wire is session-namespaced. Per-session commands arrive as a JSON body on
 * `POST /sessions/:id/control` (the session id comes from the URL, never the body); the response is
 * that request's JSON body. Each session streams out of `GET /sessions/:id/events` as SSE — a curated
 * subset of the harness's event surface (the `AgentEvent` stream plus queue/model/thinking updates),
 * never the own-events. A low-volume root control stream (`GET /events`) carries the agent snapshot +
 * session lifecycle (added/removed/renamed).
 */

import type { Api, ImageContent, Model, OAuthSelectOption } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	AgentMessage,
	CompactionEndEvent,
	CompactionStartEvent,
	ModelUpdateEvent,
	QueueUpdateEvent,
	ThinkingLevel,
	ThinkingLevelUpdateEvent,
} from "@opsyhq/agent";
import type { AgentConfig } from "./core/agent-settings-manager.ts";
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
	| { id?: string; type: "abort_compaction" }
	| { id?: string; type: "wait_for_idle" }
	| { id?: string; type: "clear_queue" }
	// Additive: create a fresh session and return its snapshot. Every other resident session stays
	// live; the TUI switches to the new one. A forming agent refuses (it stays in its birth session).
	| { id?: string; type: "create_session" }
	| { id?: string; type: "reload" }
	// The single post-confirm deploy commit: flip the latch, install the OS service, swap to a
	// fresh deployed session. Returns the fresh snapshot (config now reads as deployed).
	| { id?: string; type: "deploy" }
	// Ask the daemon to self-exit gracefully (the pid-free replacement for SIGTERM): it acks, then
	// closes its listener and exits, freeing the fixed port. Drives the stop-then-start deploy handoff.
	| { id?: string; type: "shutdown" }

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
	| { id?: string; type: "set_enabled_models"; enabledModels?: string[] }

	// Provider login — driven daemon-side so credentials never cross the wire; the OAuth flow prompts
	// the client over the dedicated login seam (the `login_ui_request`/`login_ui_response` frames below,
	// parallel to the extension-UI seam). `login_cancel` aborts the in-flight login (the client closed
	// the dialog).
	| { id?: string; type: "login"; provider: string; authType: "oauth" | "api_key" }
	| { id?: string; type: "login_cancel" }
	| { id?: string; type: "logout"; provider: string }
	| { id?: string; type: "get_login_providers"; authType?: "oauth" | "api_key" }
	| { id?: string; type: "get_logout_providers" };

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

/** A login/logout-eligible provider: its id, display name, and how it authenticates. */
export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
};

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
// Login UI (the daemon→client login seam — parallel to extension-UI, separate from it)
// ============================================================================

/**
 * A login-UI request, pushed to attach clients as an SSE frame (NOT an `AgentHarnessEvent`, like
 * `ExtensionUIRequest`). It maps 1:1 onto pi-ai's `OAuthLoginCallbacks`: `auth`/`deviceCode`/`progress`
 * are fire-and-forget; `prompt`/`manualInput`/`select` park a promise keyed by `id` and the client
 * answers via `POST /sessions/:id/login-response`. Login is a built-in, so this seam is deliberately
 * separate from the extension-UI one.
 */
export type LoginUIRequest =
	| { type: "login_ui_request"; id: string; method: "auth"; url: string; instructions?: string }
	| { type: "login_ui_request"; id: string; method: "deviceCode"; userCode: string; verificationUri: string }
	| { type: "login_ui_request"; id: string; method: "progress"; message: string }
	| { type: "login_ui_request"; id: string; method: "prompt"; message: string; placeholder?: string }
	| { type: "login_ui_request"; id: string; method: "manualInput" }
	| { type: "login_ui_request"; id: string; method: "select"; message: string; options: OAuthSelectOption[] };

/** A client's answer to an awaited `LoginUIRequest`, posted to `/login-response`. */
export type LoginUIResponse =
	| { type: "login_ui_response"; id: string; value: string }
	| { type: "login_ui_response"; id: string; cancelled: true };

// ============================================================================
// Agent + session state (hello snapshots / get_state / list)
// ============================================================================

/** One session in the agent's list — the control-stream hello and `GET /sessions` carry these. */
export interface DaemonSessionSummary {
	sessionId: string;
	sessionName?: string;
	createdAt?: string;
	isStreaming: boolean;
	/** Whether the session is currently resident (in-memory) on the daemon. */
	live: boolean;
}

/**
 * The agent-global snapshot — rides the root control stream's `hello` and `GET /sessions`. Holds the
 * fields that are the same for every session (config, cwd) plus the current session list.
 */
export interface DaemonAgentState {
	/** The agent's config (mirrors `runtime.config`) — the client reads it without a round-trip. */
	config: AgentConfig;
	/** The agent's home dir (mirrors `runtime.getCwd()`) — built-in tool renderers reconstruct from it. */
	cwd: string;
	/** Every stored session (resident + idle), newest first. */
	sessions: DaemonSessionSummary[];
}

/** The per-session `get_state` / session-stream `hello` snapshot. */
export interface DaemonSessionState {
	sessionId: string;
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	scopedModels: ScopedModel[];
	isStreaming: boolean;
	sessionName?: string;
	sessionFile?: string;
	messageCount: number;
	pendingMessageCount: number;
}

/**
 * Session lifecycle frames pushed on the root control stream (`GET /events`), so a client tracking the
 * open-session list keeps it fresh without polling `GET /sessions`.
 */
export type DaemonControlEvent =
	| { type: "session_added"; session: DaemonSessionSummary }
	| { type: "session_removed"; sessionId: string }
	| { type: "session_renamed"; sessionId: string; sessionName?: string };

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
	| CompactionStartEvent
	| CompactionEndEvent
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
	"compaction_start",
	"compaction_end",
	// Host-originated daemon event
	"scoped_models_update",
]);
