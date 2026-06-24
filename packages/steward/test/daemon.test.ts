/**
 * Daemon mode (HTTP/SSE server) integration — against a REAL `AgentRuntime` + a faux
 * provider (no network), so the whole transport runs: bearer auth, the `POST /control`
 * command switch, the curated `GET /events` SSE stream, `Last-Event-ID` replay, and the
 * rebind-on-`new_session` re-subscribe.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Api, fauxAssistantMessage, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import type { ServerType } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { runDaemonMode } from "../src/server.ts";
import { FORWARDED_EVENT_TYPES } from "../src/types.ts";

const AGENT = "scribe";
const TOKEN = "test-bearer-token-1234567890";

let home: string;
let sharedDir: string;
const registrations: Array<{ unregister(): void }> = [];
const sseClients: SseClient[] = [];
let activeRuntime: AgentRuntime | undefined;
let activeServer: ServerType | undefined;

function makeRuntime(): { runtime: AgentRuntime; registration: ReturnType<typeof registerFauxProvider> } {
	const registration = registerFauxProvider();
	registrations.push(registration);
	// Faux models are typed Model<string>; the runtime wants Model<Api>.
	const model = registration.getModel() as unknown as Model<Api>;
	const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
	// Request-time auth routes through ModelRegistry, which requires a resolvable API
	// key; the faux provider has none, so inject a runtime override (stands in for a
	// real provider being authed).
	authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
	const runtime = new AgentRuntime({
		name: AGENT,
		model,
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage),
		integrationAccounts: IntegrationAccountStorage.inMemory(),
	});
	return { runtime, registration };
}

/** Build + start a runtime, wrap it in a daemon on an ephemeral port. Returns the faux provider. */
async function startDaemon(opts: { deploy?: boolean } = {}): Promise<ReturnType<typeof registerFauxProvider>> {
	if (opts.deploy) AgentSettingsManager.create(AGENT).setAgentDeployed();
	const { runtime, registration } = makeRuntime();
	activeRuntime = runtime;
	await runtime.createConversation();
	activeServer = await runDaemonMode(runtime, { port: 0, token: TOKEN });
	return registration;
}

function baseUrl(): string {
	const addr = activeServer?.address();
	if (typeof addr === "object" && addr) return `http://127.0.0.1:${addr.port}`;
	throw new Error("daemon server is not listening");
}

/** POST a command to /control with the bearer token and return the parsed JSON response. */
async function control(command: object): Promise<{ success: boolean; command: string; data?: any; error?: string }> {
	const res = await fetch(`${baseUrl()}/control`, {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(command),
	});
	return res.json() as Promise<{ success: boolean; command: string; data?: any; error?: string }>;
}

/** Answer an awaited daemon-side dialog (the client half of the onboarding round-trip). */
async function uiRespond(id: string, answer: Record<string, unknown>): Promise<void> {
	await fetch(`${baseUrl()}/ui-response`, {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ type: "extension_ui_response", id, ...answer }),
	});
}

/** Write a minimal self-contained local package fixture (a `steward` manifest + its files). */
function writePackage(dir: string, steward: Record<string, string[]>, files: Record<string, string>): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: basename(dir), steward }));
	for (const [rel, content] of Object.entries(files)) {
		writeFileSync(join(dir, rel), content);
	}
	return dir;
}

function newSse(): SseClient {
	const client = new SseClient();
	sseClients.push(client);
	return client;
}

interface SseEvent {
	id?: string;
	event?: string;
	data: string;
}

/** The forwarded harness-event type carried by a `message` SSE frame (undefined otherwise). */
function dataType(e: SseEvent): string | undefined {
	if (e.event !== "message") return undefined;
	try {
		return (JSON.parse(e.data) as { type: string }).type;
	} catch {
		return undefined;
	}
}

/** A minimal SSE reader over `fetch` — accumulates frames and lets a test await a match. */
class SseClient {
	readonly events: SseEvent[] = [];
	readonly controller = new AbortController();
	status = 0;
	private buffer = "";
	private waiters: Array<{ pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }> = [];

	async connect(url: string, opts: { token?: string; lastEventId?: string } = {}): Promise<number> {
		const headers: Record<string, string> = {};
		if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
		if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = opts.lastEventId;
		const res = await fetch(url, { headers, signal: this.controller.signal });
		this.status = res.status;
		if (res.ok && res.body) void this.pump(res.body);
		else await res.text();
		return res.status;
	}

	private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.buffer += decoder.decode(value, { stream: true });
				this.flush();
			}
		} catch {
			/* aborted on close */
		}
	}

	private flush(): void {
		let idx = this.buffer.indexOf("\n\n");
		while (idx !== -1) {
			const raw = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 2);
			idx = this.buffer.indexOf("\n\n");
			if (raw.length === 0 || raw.startsWith(":")) continue; // keepalive comment / blank
			const event = parseFrame(raw);
			this.events.push(event);
			this.waiters = this.waiters.filter((w) => {
				if (w.pred(event)) {
					w.resolve(event);
					return false;
				}
				return true;
			});
		}
	}

	waitFor(pred: (e: SseEvent) => boolean, timeoutMs = 5000): Promise<SseEvent> {
		const existing = this.events.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for SSE event")), timeoutMs);
			this.waiters.push({
				pred,
				resolve: (e) => {
					clearTimeout(timer);
					resolve(e);
				},
			});
		});
	}

	close(): void {
		this.controller.abort();
	}
}

function parseFrame(raw: string): SseEvent {
	const event: SseEvent = { data: "" };
	const dataLines: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		else if (line.startsWith("event:")) event.event = line.slice(6).trim();
		else if (line.startsWith("id:")) event.id = line.slice(3).trim();
	}
	event.data = dataLines.join("\n");
	return event;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-daemon-home-"));
	sharedDir = mkdtempSync(join(tmpdir(), "steward-daemon-shared-"));
	process.env.STEWARD_HOME = home;
	process.env.STEWARD_SHARED_DIR = sharedDir;
	// The deploy verb installs an OS service — force the inert `none` backend so the suite never
	// registers a real launchd/systemd unit.
	process.env.STEWARD_SERVICE_MANAGER = "none";
	// The package/onboarding verbs install local fixtures only — never let resolution hit the network.
	process.env.STEWARD_OFFLINE = "1";
	AgentSettingsManager.createAgent({ name: AGENT });
});

afterEach(async () => {
	for (const client of sseClients.splice(0)) client.close();
	if (activeServer) {
		// Force-close lingering SSE sockets so server.close() doesn't hang (not on every ServerType).
		(activeServer as { closeAllConnections?: () => void }).closeAllConnections?.();
		await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
		activeServer = undefined;
	}
	if (activeRuntime) {
		await activeRuntime.cleanup();
		activeRuntime = undefined;
	}
	for (const registration of registrations.splice(0)) registration.unregister();
	delete process.env.STEWARD_HOME;
	delete process.env.STEWARD_SHARED_DIR;
	delete process.env.STEWARD_SERVICE_MANAGER;
	delete process.env.STEWARD_OFFLINE;
	rmSync(home, { recursive: true, force: true });
	rmSync(sharedDir, { recursive: true, force: true });
});

describe("daemon curation allowlist", () => {
	it("forwards the lifecycle + update events but never internal own-events", () => {
		for (const type of [
			"agent_start",
			"agent_end",
			"message_update",
			"message_end",
			"queue_update",
			"model_update",
		]) {
			expect(FORWARDED_EVENT_TYPES.has(type as never)).toBe(true);
		}
		for (const type of ["save_point", "settled", "abort", "session_compact", "tools_update", "resources_update"]) {
			expect(FORWARDED_EVENT_TYPES.has(type as never)).toBe(false);
		}
	});
});

describe("daemon HTTP/SSE server", () => {
	it("serves /health without auth", async () => {
		await startDaemon();
		const res = await fetch(`${baseUrl()}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", agent: AGENT, pid: process.pid });
	});

	it("rejects /events and /control without the bearer token", async () => {
		await startDaemon();
		const events = await fetch(`${baseUrl()}/events`);
		expect(events.status).toBe(401);
		await events.text();
		const ctl = await fetch(`${baseUrl()}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "get_state" }),
		});
		expect(ctl.status).toBe(401);
		await ctl.text();
	});

	it("returns the session snapshot from get_state", async () => {
		await startDaemon();
		const res = await control({ type: "get_state" });
		expect(res).toMatchObject({ command: "get_state", success: true });
		expect(res.data).toMatchObject({
			isStreaming: false,
			messageCount: 0,
			thinkingLevel: "off",
			pendingMessageCount: 0,
		});
		expect(res.data.model).toBeDefined();
		expect(typeof res.data.sessionId).toBe("string");
		expect(res.data.sessionId.length).toBeGreaterThan(0);
		expect(typeof res.data.sessionFile).toBe("string");
	});

	it("errors on an unknown command", async () => {
		await startDaemon();
		const res = await control({ type: "does_not_exist" });
		expect(res).toMatchObject({ success: false });
		expect(res.error).toContain("Unknown command");
	});

	it("emits a hello snapshot when a client attaches", async () => {
		await startDaemon();
		const client = newSse();
		await client.connect(`${baseUrl()}/events`, { token: TOKEN });
		const hello = await client.waitFor((e) => e.event === "hello");
		expect(JSON.parse(hello.data)).toMatchObject({ isStreaming: false, messageCount: 0 });
	});

	it("acks a prompt, streams its turn over SSE, and never forwards internal own-events", async () => {
		const registration = await startDaemon();
		registration.setResponses([() => fauxAssistantMessage("hello from the faux model")]);

		const client = newSse();
		await client.connect(`${baseUrl()}/events`, { token: TOKEN });
		await client.waitFor((e) => e.event === "hello");

		// The ack returns the instant the prompt is accepted — well before the turn ends.
		const ack = await control({ type: "prompt", message: "say hi" });
		expect(ack).toMatchObject({ command: "prompt", success: true });

		await client.waitFor((e) => dataType(e) === "agent_end");
		const streamed = client.events.map(dataType).filter(Boolean);
		expect(streamed).toContain("message_update");
		expect(streamed).toContain("agent_end");
		// Curation: the harness's own-events must not leak onto the wire.
		expect(streamed).not.toContain("save_point");
		expect(streamed).not.toContain("settled");
	});

	it("replays buffered events on reconnect with Last-Event-ID", async () => {
		const registration = await startDaemon();
		registration.setResponses([() => fauxAssistantMessage("buffered turn")]);

		const client = newSse();
		await client.connect(`${baseUrl()}/events`, { token: TOKEN });
		await client.waitFor((e) => e.event === "hello");
		await control({ type: "prompt", message: "go" });
		await client.waitFor((e) => dataType(e) === "agent_end");

		const ids = client.events.filter((e) => e.id !== undefined).map((e) => Number(e.id));
		const firstId = Math.min(...ids);
		const lastId = Math.max(...ids);
		expect(lastId).toBeGreaterThan(firstId);

		// Reconnect from firstId: events with id > firstId replay, firstId itself does not.
		const replay = newSse();
		await replay.connect(`${baseUrl()}/events`, { token: TOKEN, lastEventId: String(firstId) });
		await replay.waitFor((e) => e.id !== undefined && Number(e.id) === lastId);
		const replayedIds = replay.events.filter((e) => e.id !== undefined).map((e) => Number(e.id));
		expect(replayedIds).toContain(lastId);
		expect(replayedIds).not.toContain(firstId);
	});

	it("keeps streaming to the same client after new_session (rebind re-subscribes exactly once)", async () => {
		const registration = await startDaemon({ deploy: true });
		registration.setResponses([() => fauxAssistantMessage("first turn"), () => fauxAssistantMessage("second turn")]);

		const client = newSse();
		await client.connect(`${baseUrl()}/events`, { token: TOKEN });
		await client.waitFor((e) => e.event === "hello");

		await control({ type: "prompt", message: "one" });
		await client.waitFor((e) => dataType(e) === "agent_end");

		// Swap the harness underneath the live SSE client.
		const swap = await control({ type: "new_session" });
		expect(swap).toMatchObject({ command: "new_session", success: true });

		// The second turn runs on the NEW harness and must still reach the same client.
		await control({ type: "prompt", message: "two" });
		await client.waitFor(
			(e) => dataType(e) === "agent_end" && client.events.filter((x) => dataType(x) === "agent_end").length >= 2,
		);

		// Exactly two agent_end across both turns — a leaked old subscription would double them.
		const agentEnds = client.events.filter((e) => dataType(e) === "agent_end").length;
		expect(agentEnds).toBe(2);
	});
});

describe("daemon client-support verbs (Slice 0)", () => {
	it("get_state snapshot now carries config + cwd", async () => {
		await startDaemon();
		const res = await control({ type: "get_state" });
		expect(res.success).toBe(true);
		expect(res.data.config).toMatchObject({ name: AGENT });
		expect(typeof res.data.cwd).toBe("string");
		expect(res.data.cwd.length).toBeGreaterThan(0);
	});

	it("get_entries returns the live session entries", async () => {
		await startDaemon();
		const res = await control({ type: "get_entries" });
		expect(res).toMatchObject({ command: "get_entries", success: true });
		expect(Array.isArray(res.data.entries)).toBe(true);
	});

	it("get_resource_summary returns loaded-resource counts", async () => {
		await startDaemon();
		const res = await control({ type: "get_resource_summary" });
		expect(res).toMatchObject({ command: "get_resource_summary", success: true });
		expect(typeof res.data.extensions).toBe("number");
		expect(Array.isArray(res.data.diagnostics)).toBe(true);
	});

	it("seed_assistant_message adds an assistant message visible in get_messages", async () => {
		await startDaemon();
		const seeded = await control({ type: "seed_assistant_message", text: "What is my purpose?" });
		expect(seeded).toMatchObject({ command: "seed_assistant_message", success: true });
		expect(seeded.data).toMatchObject({ role: "assistant" });
		const msgs = await control({ type: "get_messages" });
		expect(JSON.stringify(msgs.data.messages)).toContain("What is my purpose?");
	});

	it("append_message appends a message into the session branch", async () => {
		await startDaemon();
		const append = await control({ type: "append_message", message: fauxAssistantMessage("appended note") });
		expect(append).toMatchObject({ command: "append_message", success: true });
		const msgs = await control({ type: "get_messages" });
		expect(JSON.stringify(msgs.data.messages)).toContain("appended note");
	});

	it("new_session accepts a deploy reason", async () => {
		await startDaemon({ deploy: true });
		const res = await control({ type: "new_session", reason: "deploy" });
		expect(res).toMatchObject({ command: "new_session", success: true });
		expect(res.data).toMatchObject({ isStreaming: false });
	});

	it("deploy flips the latch and swaps to a fresh deployed session", async () => {
		await startDaemon(); // forming (not pre-deployed)
		expect(AgentSettingsManager.create(AGENT).getAgentDeployed()).toBe(false);
		const before = await control({ type: "get_state" });
		const birthSessionId = before.data.sessionId;

		const res = await control({ type: "deploy" });
		expect(res).toMatchObject({ command: "deploy", success: true });
		// The swap re-reads agent.json, so the returned snapshot config reads as deployed.
		expect(res.data.config.deployedAt).toBeTruthy();
		expect(res.data).toMatchObject({ isStreaming: false });
		// Deploy always swaps to a fresh session — the supervised daemon resumes the most-recent one.
		expect(res.data.sessionId).not.toBe(birthSessionId);
		// And the latch is persisted to disk.
		expect(AgentSettingsManager.create(AGENT).getAgentDeployed()).toBe(true);
	});
});

describe("daemon plugin/onboarding consistency", () => {
	it("install_plugin is reflected in get_resource_summary with no stale cache; update + remove work", async () => {
		await startDaemon();
		const before = (await control({ type: "get_resource_summary" })).data.extensions as number;

		// A self-contained local plugin contributing one (no-op) extension.
		const pkg = writePackage(
			join(home, "ext-pkg"),
			{ extensions: ["./ext.ts"] },
			{ "ext.ts": "export default function () {}\n" },
		);
		expect(await control({ type: "install_plugin", source: pkg })).toMatchObject({
			command: "install_plugin",
			success: true,
		});

		// Single-writer freshness: the daemon installed + reloaded ITSELF, so the new extension is
		// already visible — no manual reload, no stale in-memory resources.
		expect((await control({ type: "get_resource_summary" })).data.extensions).toBe(before + 1);

		expect(await control({ type: "update_plugins" })).toMatchObject({
			command: "update_plugins",
			success: true,
		});

		const removed = await control({ type: "remove_plugin", source: pkg });
		expect(removed).toMatchObject({ command: "remove_plugin", success: true });
		expect(removed.data).toEqual({ removed: true });
		// Removal reloaded too — the extension is gone again.
		expect((await control({ type: "get_resource_summary" })).data.extensions).toBe(before);
	});

	it("remove_plugin reports removed:false when nothing matches", async () => {
		await startDaemon();
		const res = await control({ type: "remove_plugin", source: join(home, "never-installed") });
		expect(res).toMatchObject({ command: "remove_plugin", success: true });
		expect(res.data).toEqual({ removed: false });
	});

	it("onboard_plugin drives the just-installed plugin's onboarding over SSE and writes through the live account store", async () => {
		await startDaemon();

		// A local plugin whose integration onboard() asks for a token over the wire.
		const onboardSource = [
			"export default function (steward) {",
			"  steward.registerIntegration({",
			'    name: "fakesvc",',
			"    onboard: async (ctx) => {",
			'      const token = await ctx.ui.input("Paste your token");',
			"      return token === undefined ? undefined : { token };",
			"    },",
			"  });",
			"}",
			"",
		].join("\n");
		const pkg = writePackage(join(home, "int-pkg"), { integrations: ["./index.ts"] }, { "index.ts": onboardSource });
		expect(await control({ type: "install_plugin", source: pkg })).toMatchObject({ success: true });

		const client = newSse();
		await client.connect(`${baseUrl()}/events`, { token: TOKEN });
		await client.waitFor((e) => e.event === "hello");

		// The verb awaits the dialog round-trip, so fire it WITHOUT awaiting; the client answers the
		// emitted frame concurrently over /ui-response, then the verb resolves. Source-scoped: the
		// daemon scans the just-installed plugin's integrations for any declaring `onboard`.
		const onboarding = control({ type: "onboard_plugin", source: pkg });

		const frame = await client.waitFor((e) => dataType(e) === "extension_ui_request");
		const req = JSON.parse(frame.data) as { id: string; method: string };
		expect(req.method).toBe("input");
		await uiRespond(req.id, { value: "secret-token" });

		const res = await onboarding;
		expect(res).toMatchObject({ command: "onboard_plugin", success: true });
		expect(res.data.results).toEqual([{ service: "fakesvc", status: "connected" }]);

		// Onboarding wrote through the runtime's LIVE account store — no cross-process refresh path.
		expect(activeRuntime?.integrationAccounts.get("fakesvc", "default")).toEqual({ token: "secret-token" });
	});
});
