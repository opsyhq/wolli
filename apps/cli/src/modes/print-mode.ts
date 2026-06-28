/**
 * Print mode (single-shot): Send the prompt, output the final assistant message, exit.
 *
 * Vendored from coding-agent's text-mode print block. The daemon's `prompt` acks on preflight (not
 * turn-end) and there's no in-process `session.state`, so the only changes are: wait for idle then
 * read `get_messages` (in place of `session.state.messages`), write to stdout directly (no TUI
 * output-guard), and drop the client's SSE connection on the way out (the daemon owns the runtime).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionHandle } from "@opsyhq/wolli";

export async function runPrintMode(session: SessionHandle, message: string): Promise<number> {
	let exitCode = 0;
	try {
		await session.prompt(message);
		await session.waitForIdle();
		const { messages } = await session.buildSessionContext();
		const lastMessage = messages[messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				exitCode = 1;
			} else {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						process.stdout.write(`${content.text}\n`);
					}
				}
			}
		}
		return exitCode;
	} finally {
		session.close();
	}
}
