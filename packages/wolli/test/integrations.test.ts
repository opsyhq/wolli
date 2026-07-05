/**
 * Integration-subsystem unit check: the producer/dispatch lifecycle the runner
 * exists to deliver, exercised against an inline heartbeat integration and an
 * in-memory credential store (no agent home, no chat turn).
 *
 * Mirrors the extension suite's "build the real seam" stance but at the runner
 * level: defineIntegration → loadIntegrationFromDefinition → IntegrationRunner →
 * bindCore → start → events out + actions in → stop.
 *
 *  1. a configured producer emits `tick` events with increasing `seq`;
 *  2. an action `.call("ping")` validates params and returns its payload;
 *  3. an invalid `emit` payload is rejected by validation → routed to onError,
 *     never delivered to listeners;
 *  4. `stop()` aborts the producer, runs its disposer, and halts further ticks.
 *
 * The file-loading suite proves a real `integrations/<service>.ts` module
 * importing from the bare "wolli" specifier loads through `loadIntegrations`,
 * and that a workflow file importing the integration file resolves — through the
 * process-global module cache the loaders' jiti shares — to the SAME stamped
 * definition the integrations loader evaluated.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import {
	defineIntegration,
	type IntegrationDefinition,
	type IntegrationError,
	type IntegrationRunContext,
	IntegrationRunner,
	loadIntegrationFromDefinition,
	loadIntegrations,
} from "../src/core/integrations/index.ts";
import { getAliases } from "../src/core/integrations/loader.ts";
import { loadWorkflows } from "../src/core/workflows/loader.ts";
import type { IntegrationWorkflowDefinition } from "../src/core/workflows/types.ts";

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

		const heartbeat = defineIntegration({
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
				const intervalMs = ctx.account.intervalMs ?? 1000;
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

		const integration = loadIntegrationFromDefinition(heartbeat, "<heartbeat>");

		// The loader stamped the service name on the definition and on every descriptor.
		expect(heartbeat.service).toBe("heartbeat");
		expect(heartbeat.events.tick).toMatchObject({ kind: "integration", service: "heartbeat", event: "tick" });

		const accounts = IntegrationAccountStorage.inMemory({
			heartbeat: { intervalMs: 5 },
		});

		const runner = new IntegrationRunner([integration], process.cwd(), accounts, IntegrationStore.inMemory());

		const errors: IntegrationError[] = [];
		runner.onError((error) => errors.push(error));

		// Subscribe to the validated-event firehose BEFORE start so no early ticks are missed.
		// A synchronous listener keeps delivery order deterministic for the assertions below.
		const ticks: Tick[] = [];
		runner.onEvent((evt) => {
			if (evt.event === "tick") ticks.push(evt.data as Tick);
		});
		const handle = runner.getIntegration("heartbeat");

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
		capturedEmit?.("tick", { seq: "x" as unknown as number, at: 0 });
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

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tmpDirs.length) {
		rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	}
});

describe("loadIntegrations", () => {
	it("loads a defineIntegration file module, stamping the service from the basename", async () => {
		const dir = join(tmp("wolli-int-"), "integrations");
		mkdirSync(dir);
		// The bare "wolli" value import is the point: it must resolve through jiti.
		writeFileSync(
			join(dir, "heartbeat.ts"),
			`
import { Type } from "typebox";
import { defineIntegration } from "wolli";

export default defineIntegration({
	events: { tick: Type.Object({ seq: Type.Number() }) },
	actions: {
		ping: {
			parameters: Type.Object({}),
			execute: async () => ({ ok: true }),
		},
	},
});
`,
		);

		const result = await loadIntegrations([join(dir, "heartbeat.ts")], dir);
		expect(result.errors).toEqual([]);
		expect(result.integrations).toHaveLength(1);
		expect(result.integrations[0].service).toBe("heartbeat");

		const runner = new IntegrationRunner(
			result.integrations,
			dir,
			IntegrationAccountStorage.inMemory({ heartbeat: {} }),
			IntegrationStore.inMemory(),
		);
		runner.bindCore();
		await expect(runner.getIntegration("heartbeat").call("ping")).resolves.toEqual({ ok: true });
	});

	it("names a package-shaped integration (<pkg>/index.ts) after its package directory", async () => {
		// The built-in plugins declare `wolli.integrations: ["./index.ts"]`; their service
		// ids (telegram/discord/scheduler) come from the package dir, not "index".
		const dir = join(tmp("wolli-int-pkg-"), "telegram");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "index.ts"),
			`
import { defineIntegration } from "wolli";

export default defineIntegration({});
`,
		);

		const result = await loadIntegrations([join(dir, "index.ts")], dir);
		expect(result.errors).toEqual([]);
		expect(result.integrations[0].service).toBe("telegram");
	});

	it("rejects a module that does not default-export a definition", async () => {
		const dir = join(tmp("wolli-int-bad-"), "integrations");
		mkdirSync(dir);
		writeFileSync(join(dir, "legacy.ts"), "export default function () {};\n");

		const result = await loadIntegrations([join(dir, "legacy.ts")], dir);
		expect(result.integrations).toEqual([]);
		expect(result.errors).toEqual([
			{
				path: join(dir, "legacy.ts"),
				error: expect.stringContaining("does not export a defineIntegration definition"),
			},
		]);
	});

	it("keeps a stamped definition's identity into workflow files through the module cache", async () => {
		const home = tmp("wolli-int-shared-");
		const intDir = join(home, "integrations");
		const wfDir = join(home, "workflows");
		mkdirSync(intDir);
		mkdirSync(wfDir);
		writeFileSync(
			join(intDir, "beat.ts"),
			`
import { Type } from "typebox";
import { defineIntegration } from "wolli";

export default defineIntegration({
	events: { tick: Type.Object({ seq: Type.Number() }) },
});
`,
		);
		writeFileSync(
			join(wfDir, "on-beat.ts"),
			`
import { defineWorkflow } from "wolli";
import beat from "../integrations/beat.ts";

export default defineWorkflow({ on: beat.events.tick, run() {} });
`,
		);

		const integrationsResult = await loadIntegrations([join(intDir, "beat.ts")], home);
		expect(integrationsResult.errors).toEqual([]);
		const workflowsResult = await loadWorkflows([join(wfDir, "on-beat.ts")], home);
		expect(workflowsResult.errors).toEqual([]);

		// The workflow's import of ../integrations/beat.ts resolved through the process-global
		// module cache to the SAME module the integrations loader stamped — its `on` descriptor
		// is beat's descriptor object, service already "beat" (a re-evaluation would carry "").
		const beat = (await createJiti(import.meta.url, { moduleCache: true, alias: getAliases() }).import(
			realpathSync(join(intDir, "beat.ts")),
			{ default: true },
		)) as IntegrationDefinition;
		expect(beat.service).toBe("beat");
		const definition = workflowsResult.workflows[0].definition as IntegrationWorkflowDefinition<unknown>;
		expect(definition.on).toBe(beat.events.tick);
		expect(definition.on.service).toBe("beat");
	});
});
