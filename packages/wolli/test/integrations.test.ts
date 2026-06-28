/**
 * Integration-subsystem unit check: the producer/dispatch lifecycle the runner
 * exists to deliver, exercised against an inline heartbeat integration and an
 * in-memory credential store (no agent home, no chat turn).
 *
 * Mirrors the extension suite's "build the real seam" stance but at the runner
 * level: inline factory → loadIntegrationFromFactory → IntegrationRunner →
 * bindCore → start → events out + actions in → stop.
 *
 *  1. a configured producer emits `tick` events with increasing `seq`;
 *  2. an action `.call("ping")` validates params and returns its payload;
 *  3. an invalid `emit` payload is rejected by validation → routed to onError,
 *     never delivered to listeners;
 *  4. `stop()` aborts the producer, runs its disposer, and halts further ticks.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	createIntegrationRuntime,
	type IntegrationError,
	type IntegrationRunContext,
	IntegrationRunner,
	type IntegrationsAPI,
	loadIntegrationFromFactory,
} from "../src/core/integrations/index.ts";

interface Tick {
	seq: number;
	at: number;
}

/** Poll `predicate` until true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("integration runner", () => {
	it("runs the heartbeat producer end-to-end without a chat turn", async () => {
		// Test-scoped capture: the producer hands us its `emit` and records whether its
		// disposer ran, so we can drive an invalid emit and assert teardown directly.
		let capturedEmit: IntegrationRunContext["emit"] | undefined;
		let disposerRan = false;

		const heartbeat: (wolli: IntegrationsAPI) => void = (wolli) => {
			wolli.registerIntegration({
				name: "heartbeat",
				account: Type.Object({ intervalMs: Type.Optional(Type.Number()) }),
				events: {
					tick: Type.Object({ seq: Type.Number(), at: Type.Number() }),
				},
				actions: {
					ping: {
						parameters: Type.Object({}),
						execute: async () => ({ ok: true, at: Date.now() }),
					},
				},
				run(ctx) {
					capturedEmit = ctx.emit;
					const account = ctx.account as { intervalMs?: number };
					const intervalMs = account.intervalMs ?? 1000;
					let seq = 0;
					const id = setInterval(() => {
						seq += 1;
						ctx.emit("tick", { seq, at: Date.now() });
					}, intervalMs);
					return () => {
						clearInterval(id);
						disposerRan = true;
					};
				},
			});
		};

		const runtime = createIntegrationRuntime();
		const integration = await loadIntegrationFromFactory(heartbeat, process.cwd(), runtime, "<heartbeat>");

		const accounts = IntegrationAccountStorage.inMemory({
			heartbeat: { default: { intervalMs: 5 } },
		});

		const runner = new IntegrationRunner(
			[integration],
			runtime,
			process.cwd(),
			accounts,
			IntegrationStore.inMemory(),
		);

		const errors: IntegrationError[] = [];
		runner.onError((error) => errors.push(error));

		// Subscribe BEFORE start so no early ticks are missed. A synchronous listener keeps
		// delivery order deterministic for the assertions below.
		const ticks: Tick[] = [];
		const handle = runner.getIntegration("heartbeat", "default");
		handle.on("tick", (data) => {
			ticks.push(data as Tick);
		});

		runner.bindCore();
		await runner.start();

		// 1. Producer emits increasing-`seq` ticks.
		await waitFor(() => ticks.length >= 2);
		expect(ticks.length).toBeGreaterThanOrEqual(2);
		expect(ticks[1].seq).toBeGreaterThan(ticks[0].seq);
		expect(typeof ticks[0].at).toBe("number");

		// 2. Action call validates params and returns its payload.
		const pong = (await handle.call("ping")) as { ok: boolean; at: number };
		expect(pong.ok).toBe(true);
		expect(typeof pong.at).toBe("number");

		// No errors from normal operation.
		expect(errors).toHaveLength(0);

		// 3. An invalid event payload is rejected by validation → onError, not delivered.
		const ticksBeforeBadEmit = ticks.length;
		expect(capturedEmit).toBeDefined();
		capturedEmit?.("tick", { seq: "x", at: 0 });
		await sleep(10);

		const badPayloadError = errors.find((e) => e.event === "tick" && /invalid 'tick' payload/.test(e.error));
		expect(badPayloadError).toBeDefined();
		expect(badPayloadError?.error).toContain("heartbeat");
		// The bogus tick never reached the listener (no string seq landed in `ticks`).
		expect(ticks.some((t) => (t.seq as unknown) === "x")).toBe(false);
		// Real ticks may still have arrived in the meantime, but none was the bad one.
		expect(ticks.length).toBeGreaterThanOrEqual(ticksBeforeBadEmit);

		// 4. stop() halts the producer and runs its disposer.
		await runner.stop();
		expect(disposerRan).toBe(true);

		const afterStop = ticks.length;
		await sleep(30); // well over the 5ms interval — no further ticks should arrive
		expect(ticks.length).toBe(afterStop);
	});
});
