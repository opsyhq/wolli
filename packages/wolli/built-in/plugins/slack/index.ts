/**
 * Slack transport — the integration half only (no routing workflows yet).
 *
 * Faces Slack over Socket Mode: `apps.connections.open` (app-level `xapp-` token)
 * returns a one-time WebSocket URL, envelopes arrive over that socket and are
 * acked immediately, and normalized `message` / `app_mention` events are emitted.
 * Outbound goes through the Web API (`chat.postMessage`, bot `xoxb-` token). No
 * public URL, TLS, or webhook signing is involved — Socket Mode has no inbound
 * HTTP surface, so the app's signing secret is NOT needed or stored.
 *
 * Zero dependencies: plain `fetch` plus Node's global `WebSocket` (Node >= 22).
 *
 * ## Slack app requirements
 *  - Socket Mode enabled (this is what mints the `xapp-` token, scope `connections:write`).
 *  - Bot token scopes: `chat:write`, `app_mentions:read`, plus the history scope for
 *    each surface it should hear (`channels:history`, `groups:history`, `im:history`,
 *    `mpim:history`).
 *  - Event Subscriptions enabled with the matching bot events (`app_mention`,
 *    `message.channels`, `message.groups`, `message.im`, `message.mpim`).
 *  - The bot only receives channel messages where it is a member (`/invite @bot`).
 *
 * ## Config (`~/.wolli/agents/<name>/integrations.json`)
 *
 *   { "slack": { "botToken": "xoxb-...", "appToken": "xapp-..." } }
 *
 * Both tokens resolve `$ENV` / `!cmd` references on read. `allowedChannelIds` is an
 * allowlist — empty/absent means "allow any channel" (logged as a warning).
 *
 * ## Known v1 limitations
 *  - Slack sends a bot mention as BOTH `app_mention` and `message`; this transport
 *    emits only `app_mention` for it, keeping the two events disjoint. The suppression
 *    needs the bot's user id from `auth.test`, so a mention landing in the first
 *    moments after connect can still emit both.
 *  - Envelopes are acked on receipt with no durable event-id dedupe, so a Slack
 *    retry after a crash can re-emit an event.
 *  - On a Slack-requested refresh the socket is closed and reopened, so events in
 *    that gap are seen only if Slack retries them.
 *  - Text only: no media, edits, deletions, reactions, slash commands, or interactive
 *    payloads (non-`events_api` envelopes are acked and dropped).
 */

// The integration surface is host-provided via the loader's VIRTUAL_MODULES / aliases, so
// wolli is a peerDependency, not a dependency.
import { defineIntegration, type IntegrationOnboardContext } from "wolli";
import { Type } from "typebox";

/** Slack cuts off a single chat.postMessage at 40,000 characters. */
const SLACK_MAX_LENGTH = 40000;

const ONBOARD_GUIDE = [
	"## Connect Slack",
	"",
	"1. Open [api.slack.com/apps](https://api.slack.com/apps) and **Create New App**",
	"   (from scratch).",
	"2. Under **Socket Mode**, enable it — this creates an **app-level token**",
	"   (`xapp-...`) with the `connections:write` scope. Copy it.",
	"3. Under **OAuth & Permissions → Bot Token Scopes**, add `chat:write`,",
	"   `app_mentions:read`, `channels:history`, `groups:history`, `im:history`,",
	"   `mpim:history`.",
	"4. Under **Event Subscriptions**, enable events and subscribe to the bot events",
	"   `app_mention`, `message.channels`, `message.groups`, `message.im`,",
	"   `message.mpim`.",
	"5. **Install to Workspace** (OAuth & Permissions) and copy the **bot token**",
	"   (`xoxb-...`).",
	"6. Invite the bot to a channel with `/invite @yourbot`, then paste both tokens",
	"   on the next screens. The signing secret is not needed — Socket Mode has no",
	"   inbound webhook to verify.",
].join("\n");

interface SlackAccount {
	botToken: string;
	appToken: string;
	allowedChannelIds?: string[];
}

/** Successful envelope of every Web API response; `ok: false` carries `error`. */
interface SlackApiOk {
	ok: boolean;
	error?: string;
}

/** One inbound Socket Mode frame. Only `events_api` envelopes carry an event. */
interface SocketEnvelope {
	type: string;
	envelope_id?: string;
	payload?: { event?: SlackEvent };
}

/** The subset of Slack event fields this transport reads. */
interface SlackEvent {
	type: string;
	subtype?: string;
	user?: string;
	bot_id?: string;
	channel?: string;
	channel_type?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
}

/** Call a Slack Web API method; throws on transport errors and `ok: false`. */
async function slackApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T & SlackApiOk> {
	const res = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = (await res.json()) as T & SlackApiOk;
	if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? `HTTP ${res.status}`}`);
	return data;
}

/** Split into ≤40,000-code-unit chunks without cutting a surrogate pair. */
function chunkText(text: string, max = SLACK_MAX_LENGTH): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + max, text.length);
		if (end < text.length) {
			const code = text.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) end -= 1;
		}
		chunks.push(text.slice(i, end));
		i = end;
	}
	return chunks;
}

/**
 * Guided setup: collect both tokens, verify the bot token with `auth.test` and the
 * app token with `apps.connections.open`, return them to store.
 */
async function onboard(ctx: IntegrationOnboardContext): Promise<{ botToken: string; appToken: string } | undefined> {
	ctx.ui.notify(ONBOARD_GUIDE, "info");

	const botEntered = await ctx.ui.input("Paste the bot token (xoxb-...)");
	if (botEntered === undefined) return undefined; // cancelled
	const botToken = botEntered.trim();
	if (!botToken) {
		ctx.ui.notify("No bot token entered.", "error");
		return undefined;
	}

	const appEntered = await ctx.ui.input("Paste the app-level token (xapp-...)");
	if (appEntered === undefined) return undefined; // cancelled
	const appToken = appEntered.trim();
	if (!appToken) {
		ctx.ui.notify("No app-level token entered.", "error");
		return undefined;
	}

	try {
		const me = await slackApi<{ user: string; team: string }>(botToken, "auth.test");
		await slackApi<{ url: string }>(appToken, "apps.connections.open");
		ctx.ui.notify(`Verified bot @${me.user} in workspace ${me.team}.`, "info");
	} catch (err) {
		ctx.ui.notify(`Could not verify the tokens: ${err instanceof Error ? err.message : String(err)}`, "error");
		return undefined;
	}

	return { botToken, appToken };
}

export default defineIntegration({
	account: Type.Object({
		/** Bot token (`xoxb-...`), used for all Web API calls. */
		botToken: Type.String(),
		/** App-level token (`xapp-...`, scope `connections:write`), used only to open the socket. */
		appToken: Type.String(),
		/** Allowlist of channel ids. Empty/absent = allow all (logged as a warning). */
		allowedChannelIds: Type.Optional(Type.Array(Type.String())),
	}),
	events: {
		/**
		 * A plain user message the bot can see (no subtype — edits, joins, bot posts are
		 * dropped). Messages that @-mention the bot arrive only as `app_mention`.
		 */
		message: Type.Object({
			channelId: Type.String(),
			/** Message timestamp — Slack's message id AND the key for replying in-thread. */
			ts: Type.String(),
			/** Present when the message is inside a thread. */
			threadTs: Type.Optional(Type.String()),
			text: Type.String(),
			user: Type.Object({ id: Type.String() }),
			/** "channel" | "group" | "im" | "mpim". */
			channelType: Type.String(),
		}),
		/** The bot was @-mentioned. Mentions are NOT also emitted as `message`. */
		app_mention: Type.Object({
			channelId: Type.String(),
			ts: Type.String(),
			threadTs: Type.Optional(Type.String()),
			text: Type.String(),
			user: Type.Object({ id: Type.String() }),
		}),
	},
	onboard,
	actions: {
		sendMessage: {
			description:
				"Send a text message to a channel via chat.postMessage (chunked at 40000; Slack renders mrkdwn). Pass threadTs to reply in a thread.",
			parameters: Type.Object({
				channelId: Type.String(),
				text: Type.String(),
				threadTs: Type.Optional(Type.String()),
			}),
			execute: async (params, ctx) => {
				const { channelId, text, threadTs } = params as {
					channelId: string;
					text: string;
					threadTs?: string;
				};
				const account = ctx.account as SlackAccount;

				const ts: string[] = [];
				for (const chunk of chunkText(text)) {
					const sent = await slackApi<{ ts: string }>(account.botToken, "chat.postMessage", {
						channel: channelId,
						text: chunk,
						...(threadTs ? { thread_ts: threadTs } : {}),
					});
					ts.push(sent.ts);
				}
				return { ts };
			},
		},
	},
	run(ctx) {
		const account = ctx.account as SlackAccount;
		const { botToken, appToken, allowedChannelIds } = account;
		const allowAll = !allowedChannelIds || allowedChannelIds.length === 0;
		if (allowAll) {
			console.warn("[slack] no allowedChannelIds configured — accepting messages from ANY channel.");
		}

		let ws: WebSocket | undefined;
		let stopped = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;

		// Self-filter id. Bot posts always carry bot_id, which is filtered regardless;
		// this covers the bot's non-bot-authored surfaces while auth.test is in flight.
		let botUserId: string | undefined;
		void slackApi<{ user_id: string }>(botToken, "auth.test")
			.then((r) => {
				botUserId = r.user_id;
			})
			.catch((err) => {
				console.error("[slack] auth.test failed:", err instanceof Error ? err.message : err);
			});

		const handleEvent = (event: SlackEvent) => {
			const channelId = event.channel;
			if (!channelId || !event.ts) return;
			if (!allowAll && !allowedChannelIds?.includes(channelId)) return;
			if (event.bot_id) return; // skip our own posts and other bots (loop prevention)
			if (!event.user || botUserId === event.user) return;
			const text = event.text;
			if (!text) return; // media-only or empty

			if (event.type === "message") {
				if (event.subtype) return; // edits, deletes, joins, bot_message, ...
				// Slack sends a bot mention as both `message` and `app_mention` — emit only the
				// latter so the events stay disjoint and consumers never double-handle a mention.
				if (botUserId && text.includes(`<@${botUserId}>`)) return;
				ctx.emit("message", {
					channelId,
					ts: event.ts,
					threadTs: event.thread_ts,
					text,
					user: { id: event.user },
					channelType: event.channel_type ?? "channel",
				});
			} else if (event.type === "app_mention") {
				ctx.emit("app_mention", {
					channelId,
					ts: event.ts,
					threadTs: event.thread_ts,
					text,
					user: { id: event.user },
				});
			}
		};

		const scheduleReconnect = () => {
			if (stopped || reconnectTimer) return;
			attempt += 1;
			const delay = Math.min(30_000, 1000 * 2 ** attempt);
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				void connect().catch((err) => {
					console.error("[slack] reconnect failed:", err instanceof Error ? err.message : err);
					scheduleReconnect();
				});
			}, delay);
		};

		const handleFrame = (socket: WebSocket, raw: string) => {
			let envelope: SocketEnvelope;
			try {
				envelope = JSON.parse(raw) as SocketEnvelope;
			} catch {
				return;
			}
			// Slack refreshes connections periodically; close and let the reconnect loop
			// fetch a fresh one-time URL.
			if (envelope.type === "disconnect") {
				socket.close();
				return;
			}
			// Ack within 3s or Slack redelivers. Ack everything (non-events_api envelopes
			// like slash_commands are acked and dropped).
			if (envelope.envelope_id) {
				socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
			}
			if (envelope.type === "events_api" && envelope.payload?.event) {
				handleEvent(envelope.payload.event);
			}
		};

		const connect = async () => {
			if (stopped) return;
			const { url } = await slackApi<{ url: string }>(appToken, "apps.connections.open");
			if (stopped) return;
			const socket = new WebSocket(url);
			ws = socket;
			socket.addEventListener("open", () => {
				attempt = 0;
			});
			socket.addEventListener("message", (e) => {
				if (typeof e.data === "string") handleFrame(socket, e.data);
			});
			socket.addEventListener("error", () => {
				// A close event always follows; reconnect is scheduled there.
			});
			socket.addEventListener("close", () => {
				if (ws === socket) scheduleReconnect();
			});
		};

		void connect().catch((err) => {
			console.error("[slack] failed to connect:", err instanceof Error ? err.message : err);
			scheduleReconnect();
		});

		const dispose = () => {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			ws?.close();
		};
		ctx.signal.addEventListener("abort", dispose);
		return dispose;
	},
});
