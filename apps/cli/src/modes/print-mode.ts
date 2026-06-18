/**
 * Print mode (single-shot), as a daemon client.
 *
 * In-process this awaited `session.prompt()` (which resolved at turn-end) and read the final
 * `session.state.messages[last]`. The daemon's `prompt` acks on preflight instead, so the client
 * waits for the turn to go idle, then reads the messages back over the wire and prints the last
 * assistant message — the same one in-process print mode printed.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { DaemonSession } from "../daemon-session.ts";

export async function runPrint(session: DaemonSession, message: string): Promise<number> {
	await session.prompt(message); // acks on preflight; the turn runs in the daemon
	await session.waitForIdle(); // block until the turn ends
	const { messages } = await session.buildSessionContext(); // get_messages

	const last = messages[messages.length - 1];
	if ((last as { role?: string })?.role !== "assistant") {
		return 0;
	}
	const assistant = last as AssistantMessage;
	const text = assistant.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");

	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		if (text.trim().length > 0) {
			process.stdout.write(`${text}\n`);
		}
		const reason = assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "Aborted." : "Unknown error.");
		process.stderr.write(`${reason}\n`);
		return 1;
	}
	process.stdout.write(`${text}\n`);
	return 0;
}
