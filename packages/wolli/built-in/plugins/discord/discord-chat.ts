/**
 * Discord chat extension — maps the transport's `message` events onto wolli sessions:
 * each channel/DM gets its own session (bound by a `discord:channel` tag), inbound text
 * is queued as a followUp, and the final assistant text is sent back on `agent_end`.
 * Paired with `index.ts`.
 */

import type { AgentMessage } from "@opsyhq/agent";
import type { ExtensionAPI } from "@opsyhq/wolli";

// Discord's typing state lasts ~10s; refresh a little ahead of that.
const TYPING_INTERVAL_MS = 8000;

interface DiscordMessage {
	channelId: string;
	messageId: string;
	text: string;
	author: { id: string; name?: string };
}

/** Text of the last assistant message; "" for a pure tool-call turn. */
function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		return m.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	}
	return "";
}

export default function (wolli: ExtensionAPI) {
	const discord = wolli.getIntegration("discord", "default");

	let typingTimer: ReturnType<typeof setInterval> | undefined;

	discord.on("message", async (data) => {
		const m = data as DiscordMessage;

		// Reuse this channel's session, or create + tag a fresh one.
		const channelTag = { "discord:channel": m.channelId };
		const [match] = await wolli.findSessions(channelTag);
		const session = match
			? await wolli.openSession(match.id)
			: await wolli.createSession({
					setup: async (sessionManager) => {
						await sessionManager.appendTags(channelTag);
					},
				});

		// followUp: a message arriving mid-turn queues instead of interrupting.
		void session.sendUserMessage(m.text, { deliverAs: "followUp" });
	});

	const stopTyping = (): void => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	};

	wolli.on("agent_start", async (_event, ctx) => {
		const channelId = ctx.session.getTags()["discord:channel"];
		if (!channelId) return; // not a discord-bound session
		const sendTyping = () => {
			void discord.call("sendTyping", { channelId }).catch(() => {});
		};
		sendTyping();
		stopTyping();
		typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);
	});

	wolli.on("agent_end", async ({ messages }, ctx) => {
		stopTyping();

		// Reply goes to the channel that started this turn (the producing session's tag).
		const channelId = ctx.session.getTags()["discord:channel"];
		if (!channelId) return; // not a discord-bound session

		const text = finalAssistantText(messages as AgentMessage[]);
		if (!text) return; // pure tool-call turn — nothing to send
		await discord.call("sendMessage", { channelId, text });
	});
}
