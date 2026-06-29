/**
 * Discord transport — holds the bot token, emits a `message` event per inbound message;
 * the paired `discord-chat.ts` extension maps those onto sessions. Transport is the
 * gateway WebSocket (discord.js `Client`); snowflake ids stay `string`. MESSAGE CONTENT
 * is a privileged intent — enable it in the Developer Portal or `m.content` is empty.
 * See README.md for setup.
 */

import type { IntegrationOnboardContext, IntegrationsAPI } from "@opsyhq/wolli";
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { Type } from "typebox";

/** Discord caps a single message at 2000 UTF-16 code units. */
const DISCORD_MAX_LENGTH = 2000;

const ONBOARD_GUIDE = [
	"## Connect Discord",
	"",
	"1. Open the [Discord Developer Portal](https://discord.com/developers/applications)",
	"   and create a **New Application**.",
	"2. Go to **Bot**, then enable the **MESSAGE CONTENT INTENT** toggle (privileged —",
	"   without it the bot receives empty message text).",
	"3. On the **Bot** page, **Reset Token** and copy the token.",
	"4. Go to **OAuth2 → URL Generator**, select the `bot` scope, copy the generated URL,",
	"   open it, and invite the bot to your server.",
	"5. Paste the token on the next screen.",
	"",
	"Wolli verifies the token and stores it for this agent.",
].join("\n");

interface DiscordAccount {
	botToken: string;
	allowedChannelIds?: string[];
}

/** One cached `REST` client per token for the request/response actions. */
const rests = new Map<string, REST>();
function getRest(token: string): REST {
	let rest = rests.get(token);
	if (!rest) {
		rest = new REST({ version: "10" }).setToken(token);
		rests.set(token, rest);
	}
	return rest;
}

/** Split into ≤2000-code-unit chunks without cutting a surrogate pair. */
function chunkText(text: string, max = DISCORD_MAX_LENGTH): string[] {
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

/** Guided setup: collect the bot token, verify it via `GET /users/@me`, return it to store. */
async function onboard(ctx: IntegrationOnboardContext): Promise<{ botToken: string } | undefined> {
	ctx.ui.notify(ONBOARD_GUIDE, "info");

	const entered = await ctx.ui.input("Paste the bot token from the Discord Developer Portal");
	if (entered === undefined) return undefined; // cancelled
	const token = entered.trim();
	if (!token) {
		ctx.ui.notify("No token entered.", "error");
		return undefined;
	}

	try {
		const me = (await new REST({ version: "10" }).setToken(token).get(Routes.user())) as { username: string };
		ctx.ui.notify(`Verified bot ${me.username}.`, "info");
	} catch (err) {
		ctx.ui.notify(`Could not verify the token: ${err instanceof Error ? err.message : String(err)}`, "error");
		return undefined;
	}

	return { botToken: token };
}

export default function (wolli: IntegrationsAPI) {
	wolli.registerIntegration({
		name: "discord",
		account: Type.Object({
			botToken: Type.String(),
			/** Empty/absent = allow all (logged as a warning). */
			allowedChannelIds: Type.Optional(Type.Array(Type.String())),
		}),
		events: {
			message: Type.Object({
				channelId: Type.String(),
				messageId: Type.String(),
				text: Type.String(),
				author: Type.Object({
					id: Type.String(),
					name: Type.Optional(Type.String()),
				}),
			}),
		},
		onboard,
		actions: {
			sendMessage: {
				description: "Send a text message to a channel (chunked at 2000; Discord renders markdown natively).",
				parameters: Type.Object({
					channelId: Type.String(),
					text: Type.String(),
				}),
				execute: async (params, ctx) => {
					const { channelId, text } = params as { channelId: string; text: string };
					const account = ctx.account as DiscordAccount;
					const rest = getRest(account.botToken);

					const messageIds: string[] = [];
					for (const content of chunkText(text)) {
						const sent = (await rest.post(Routes.channelMessages(channelId), { body: { content } })) as {
							id: string;
						};
						messageIds.push(sent.id);
					}
					return { messageIds };
				},
			},
			sendTyping: {
				description: "Show the 'typing…' indicator in a channel (lasts ~10s).",
				parameters: Type.Object({
					channelId: Type.String(),
				}),
				execute: async (params, ctx) => {
					const { channelId } = params as { channelId: string };
					const account = ctx.account as DiscordAccount;
					const rest = getRest(account.botToken);
					await rest.post(Routes.channelTyping(channelId));
					return { ok: true };
				},
			},
		},
		run(ctx) {
			const account = ctx.account as DiscordAccount;
			const { botToken, allowedChannelIds } = account;
			const allowAll = !allowedChannelIds || allowedChannelIds.length === 0;
			if (allowAll) {
				console.warn("[discord] no allowedChannelIds configured — accepting messages from ANY channel.");
			}

			const client = new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.MessageContent,
					GatewayIntentBits.DirectMessages,
				],
				partials: [Partials.Channel], // required to receive DMs
			});

			client.on(Events.MessageCreate, (m) => {
				if (m.author.id === client.user?.id) return; // skip self
				if (m.author.bot) return; // skip other bots (loop prevention)
				if (!allowAll && !allowedChannelIds?.includes(m.channelId)) return;
				const text = m.content;
				if (!text) return; // empty without the MESSAGE CONTENT intent, or media-only

				ctx.emit("message", {
					channelId: m.channelId,
					messageId: m.id,
					text,
					author: { id: m.author.id, name: m.author.username },
				});
			});

			client.on(Events.Error, (err) => {
				console.error("[discord] client error:", err.message);
			});

			// Fire-and-forget: login never settles into a state we await.
			if (!ctx.signal.aborted) {
				void client.login(botToken).catch((err) => {
					console.error("[discord] failed to log in:", err instanceof Error ? err.message : err);
				});
			}

			const dispose = () => void client.destroy();
			ctx.signal.addEventListener("abort", dispose);
			return dispose;
		},
	});
}
