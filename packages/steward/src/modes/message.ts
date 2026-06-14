/**
 * Small helpers for reading an `AssistantMessage`, shared by both modes.
 *
 * Kept free of any `@opsyhq/tui` import so the print path stays lightweight —
 * `print-mode.ts` must not transitively pull in the TUI.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

/** Concatenate the text blocks of an assistant message into one string. */
export function collectText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * A failure message is what `AgentHarness` emits when a turn errors or is
 * aborted: an assistant message with an empty body and the detail in
 * `errorMessage` (see `createFailureMessage`). It still flows through the normal
 * `message_start`/`message_end` events, so callers have to special-case it
 * rather than render an empty bubble.
 */
export function isFailureMessage(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}
