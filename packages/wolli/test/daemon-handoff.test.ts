/**
 * The deploy/restart handoff must wait for the *replacement* daemon, not just any `/health` 200: undici
 * keep-alive can answer a probe from the old daemon before the replacement has bound the reused port, so
 * `waitForRestart` keys on the reported `startedAt`. Exercised against a fake `/health` whose `startedAt`
 * is flipped under the test's control (old daemon lingering, then the replacement coming up).
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHealthy, waitForRestart } from "../src/client.ts";

const BOOT = "2020-01-01T00:00:00.000Z";

let server: Server | undefined;
let base = "";
// The `startedAt` the fake daemon reports from `/health`; null → it answers 503 (up but unhealthy).
let startedAt: string | null = BOOT;

beforeEach(async () => {
	startedAt = BOOT;
	server = createServer((req, res) => {
		if (req.url !== "/health") {
			res.statusCode = 404;
			res.end();
			return;
		}
		if (!startedAt) {
			res.statusCode = 503;
			res.end();
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ status: "ok", agent: "t", pid: 1, startedAt }));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const addr = server?.address();
	if (typeof addr !== "object" || !addr) throw new Error("server is not listening");
	base = `http://127.0.0.1:${addr.port}`;
});

async function stopServer(): Promise<void> {
	if (!server) return;
	// Drop keep-alive sockets so close() doesn't hang on a pooled undici connection.
	server.closeAllConnections?.();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
}

afterEach(stopServer);

describe("daemon handoff health probes", () => {
	it("isHealthy is true while a daemon answers, false when it is unhealthy", async () => {
		expect(await isHealthy(base)).toBe(true);
		startedAt = null;
		expect(await isHealthy(base)).toBe(false);
	});

	it("isHealthy is false when nothing answers", async () => {
		const dead = base;
		await stopServer();
		expect(await isHealthy(dead)).toBe(false);
	});

	it("waitForRestart ignores the old daemon and resolves only once a replacement is serving", async () => {
		// While `/health` still reports the SAME startedAt (the old daemon answering over a lingering
		// keep-alive socket), waitForRestart must NOT resolve — the exact false-positive the race hit.
		let resolved = false;
		const wait = waitForRestart(base, BOOT).then(() => {
			resolved = true;
		});
		await new Promise((r) => setTimeout(r, 500));
		expect(resolved).toBe(false);

		// The replacement binds the port and reports a later boot time → waitForRestart resolves.
		startedAt = "2020-01-01T00:00:01.000Z";
		await wait;
		expect(resolved).toBe(true);
	});

	it("waitForRestart treats any healthy daemon as the replacement when there was none before", async () => {
		await expect(waitForRestart(base, null)).resolves.toBeUndefined();
	});
});
