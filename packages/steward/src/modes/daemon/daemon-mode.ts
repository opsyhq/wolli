/**
 * Daemon mode: a long-running HTTP/SSE server wrapping a `SessionHost`.
 *
 *   - `GET /events`  (SSE)  — the curated event stream + async prompt acks;
 *   - `POST /control`       — commands, whose sync response is the HTTP body;
 *   - `GET /health`         — liveness, no auth.
 *
 * `SessionHost` owns every lifecycle concern (start/newSession/reload/cleanup); this is a
 * thin wrapper that calls into it.
 */

import { type ServerType, serve } from "@hono/node-server";
import type { AgentHarness, AgentHarnessEvent } from "@opsyhq/agent";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { loadDaemonDescriptor, saveDaemonDescriptor } from "../../core/daemon-descriptor.ts";
import type { SessionHost } from "../../core/session-host.ts";
import {
	type DaemonCommand,
	type DaemonCommandType,
	type DaemonEvent,
	type DaemonResponse,
	type DaemonSessionState,
	FORWARDED_EVENT_TYPES,
} from "./daemon-types.ts";

/** How many recent events the broadcaster keeps for `Last-Event-ID` replay. */
const RING_SIZE = 256;
/** Keepalive comment interval — without periodic traffic idle SSE connections drop. */
const KEEPALIVE_MS = 15_000;

/** `ok()` omits `data` entirely when undefined (async-ack commands carry no payload). */
function ok(id: string | undefined, command: DaemonCommandType, data?: unknown): DaemonResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true };
	}
	return { id, type: "response", command, success: true, data };
}

function err(id: string | undefined, command: string, message: string): DaemonResponse {
	return { id, type: "response", command, success: false, error: message };
}

/** A minimal deferred, used so `prompt` can ack acceptance without awaiting the whole turn. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** The `get_state` / `hello` snapshot — only the fields the host actually surfaces. */
function snapshot(host: SessionHost): DaemonSessionState {
	const harness = host.harness;
	return {
		model: harness.getModel(),
		thinkingLevel: harness.getThinkingLevel(),
		isStreaming: !harness.isIdle,
		sessionId: host.getSessionId(),
		sessionName: host.getSessionName(),
		sessionFile: host.getSessionFile(),
		messageCount: host.buildSessionContext().messages.length,
		pendingMessageCount: host.getPendingMessageCount(),
		config: host.config,
		cwd: host.getCwd(),
	};
}

/**
 * Drive `host.prompt()` and ack the instant the prompt is accepted (handled, queued, or
 * about to run) rather than when the whole turn ends — `host.prompt()` only resolves at
 * turn end. The turn itself streams over SSE; `agent_end` marks completion.
 */
async function handlePrompt(
	host: SessionHost,
	cmd: Extract<DaemonCommand, { type: "prompt" }>,
): Promise<DaemonResponse> {
	const accepted = deferred<void>();
	void host
		.prompt(cmd.message, {
			images: cmd.images,
			source: "rpc",
			streamingBehavior: cmd.streamingBehavior,
			preflightResult: (success) => {
				if (success) accepted.resolve();
			},
		})
		// A rejected prompt (e.g. an ambiguous mid-stream submit) throws its real error here; a
		// later turn-time failure is a no-op against the already-resolved deferred.
		.catch((e) => accepted.reject(e instanceof Error ? e : new Error(String(e))));
	await accepted.promise;
	return ok(cmd.id, "prompt");
}

/**
 * The command dispatch switch. Throws on command-level failure (caught by the `/control`
 * route, surfaced as `err`).
 */
async function handleCommand(host: SessionHost, cmd: DaemonCommand): Promise<DaemonResponse> {
	const id = cmd.id;
	const harness = host.harness;

	switch (cmd.type) {
		// Prompting
		case "prompt":
			return handlePrompt(host, cmd);
		case "steer":
			await harness.steer(cmd.message, { images: cmd.images });
			return ok(id, "steer");
		case "follow_up":
			await harness.followUp(cmd.message, { images: cmd.images });
			return ok(id, "follow_up");
		case "abort":
			return ok(id, "abort", await harness.abort());
		case "compact":
			return ok(id, "compact", await harness.compact(cmd.customInstructions));
		case "wait_for_idle":
			await harness.waitForIdle();
			return ok(id, "wait_for_idle");
		case "clear_queue":
			return ok(id, "clear_queue", await host.clearQueue());
		case "new_session":
			// Return the fresh snapshot — never the harness the swap returns.
			await host.newSession({ reason: cmd.reason ?? "new" });
			return ok(id, "new_session", snapshot(host));
		case "reload":
			await host.reload();
			return ok(id, "reload");

		// Model / thinking
		case "set_thinking_level":
			await harness.setThinkingLevel(cmd.level);
			return ok(id, "set_thinking_level");
		case "set_model":
			return ok(id, "set_model", await host.setModelById(cmd.provider, cmd.modelId));

		// State
		case "get_state":
			return ok(id, "get_state", snapshot(host));
		case "get_messages":
			return ok(id, "get_messages", { messages: host.buildSessionContext().messages });
		case "get_commands":
			return ok(id, "get_commands", { commands: host.getCommands() });
		case "get_entries":
			return ok(id, "get_entries", { entries: host.getEntries() });
		case "get_resource_summary":
			return ok(id, "get_resource_summary", host.getResourceSummary());

		// Session-mutation helpers
		case "seed_assistant_message":
			return ok(id, "seed_assistant_message", await host.seedAssistantMessage(cmd.text));
		case "append_message":
			await harness.appendMessage(cmd.message);
			return ok(id, "append_message");

		default: {
			const unknown = cmd as { type: string };
			return err(undefined, unknown.type, `Unknown command: ${unknown.type}`);
		}
	}
}

/**
 * Run the daemon: bind a loopback HTTP/SSE server wrapping `host`, subscribe the broadcaster
 * to the live harness (re-subscribing after every swap), and resolve once it is listening.
 * Returns the `serve()` server so the launcher can `server.close()` on shutdown — closing the
 * server drops the broadcaster subscription (via the `close` listener below), the leak
 * `host.cleanup()` does not cover.
 */
export async function runDaemonMode(host: SessionHost, options: { port: number; token: string }): Promise<ServerType> {
	const startedAt = new Date().toISOString();

	// ---- Event broadcaster ------------------------------------------------
	const clients = new Set<SSEStreamingApi>();
	let seq = 0;
	const ring: { id: number; frame: string }[] = [];

	const broadcast = async (event: AgentHarnessEvent): Promise<void> => {
		// Curation: forward only the allowlisted AgentEvent + queue/model/thinking updates;
		// drop the internal own-events (save_point, settled, abort, session_*, tools_update, …).
		if (!FORWARDED_EVENT_TYPES.has(event.type as DaemonEvent["type"])) return;
		seq += 1;
		const id = seq;
		const frame = JSON.stringify(event);
		ring.push({ id, frame });
		if (ring.length > RING_SIZE) ring.shift();
		for (const client of clients) {
			if (client.aborted) {
				clients.delete(client);
				continue;
			}
			await client.writeSSE({ id: String(id), event: "message", data: frame });
		}
	};

	// ---- Subscribe + rebind -----------------------------------------------
	// Keep exactly one subscription on the live harness: unsub-old → sub-new → store.
	let unsubscribe: (() => void) | undefined;
	const resubscribe = (harness: AgentHarness): void => {
		unsubscribe?.();
		unsubscribe = harness.subscribe(broadcast);
	};
	resubscribe(host.harness);
	// Re-fire after every harness swap (build/newSession) and after reload.
	host.setRebindHandler(resubscribe);

	// ---- HTTP app ---------------------------------------------------------
	const app = new Hono();
	app.use("/events", bearerAuth({ token: options.token }));
	app.use("/control", bearerAuth({ token: options.token }));

	app.get("/health", (c) => c.json({ status: "ok", agent: host.config.name, pid: process.pid, startedAt }));

	app.get("/events", (c) =>
		streamSSE(c, async (stream) => {
			clients.add(stream);
			// Capture the replay watermark with NO intervening await, so live broadcasts
			// (id > watermark) and replayed events (id ≤ watermark) stay disjoint — no
			// double-delivery across the reconnect boundary.
			const replayUpTo = seq;
			stream.onAbort(() => {
				clients.delete(stream);
			});

			// Replay buffered events after the client's Last-Event-ID, bounded by the watermark.
			const lastEventId = c.req.header("Last-Event-ID");
			if (lastEventId !== undefined) {
				const after = Number(lastEventId);
				for (const entry of ring) {
					if (entry.id > after && entry.id <= replayUpTo) {
						await stream.writeSSE({ id: String(entry.id), event: "message", data: entry.frame });
					}
				}
			}

			// hello = the get_state snapshot, so a fresh attach knows the current state at once.
			await stream.writeSSE({ event: "hello", data: JSON.stringify(snapshot(host)) });

			// Mandatory keepalive: Hono closes the stream when this callback returns, so the
			// loop must run for the connection's lifetime (Hono issue #2993). The heartbeat
			// is a raw SSE comment via stream.write (not writeSSE).
			while (!stream.aborted) {
				await stream.sleep(KEEPALIVE_MS);
				if (stream.aborted) break;
				await stream.write(": ping\n\n");
			}
		}),
	);

	app.post("/control", async (c) => {
		const cmd = await c.req.json<DaemonCommand>();
		try {
			return c.json(await handleCommand(host, cmd));
		} catch (e) {
			return c.json(err(cmd.id, cmd.type, e instanceof Error ? e.message : String(e)));
		}
	});

	// ---- Serve ------------------------------------------------------------
	// Patch the resolved port back into the descriptor — for `port: 0` the real port is only
	// known once the OS assigns it (read off serve()'s `info.port`).
	const writePortBack = (port: number): void => {
		const existing = loadDaemonDescriptor(host.config.name);
		if (existing) saveDaemonDescriptor(host.config.name, { ...existing, port });
	};

	const server = await new Promise<ServerType>((resolve) => {
		const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port }, (info) => {
			writePortBack(info.port);
			resolve(s);
		});
	});

	// host.cleanup() does NOT drop the broadcaster subscription, so tie it to server close.
	server.on("close", () => {
		try {
			unsubscribe?.();
		} catch {
			/* harness already gone with its subscription */
		}
	});

	return server;
}
