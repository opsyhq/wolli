import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { CompactionEndEvent, CompactionSettings, CompactionStartEvent } from "../../src/harness/types.ts";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

// A compaction summary is generated through completeSimple, which draws from the same faux response
// queue as the streamed turn — so a turn that compacts needs a follow-up summary response queued.
const SUMMARY_RESPONSE = () => fauxAssistantMessage("## Goal\nsummary");

/** Build a harness over a faux provider, with auth + compaction settings wired so auto-compaction runs. */
function createHarness(options: { settings: CompactionSettings; contextWindow?: number }): {
	harness: AgentHarness;
	registration: FauxProviderRegistration;
} {
	const registration = registerFauxProvider({
		models: [{ id: "faux", contextWindow: options.contextWindow ?? 128000 }],
	});
	registrations.push(registration);
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: new Session(new InMemorySessionStorage()),
		model: registration.getModel(),
		getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		getCompactionSettings: () => options.settings,
	});
	return { harness, registration };
}

function collectCompactionEvents(harness: AgentHarness): {
	starts: CompactionStartEvent[];
	ends: CompactionEndEvent[];
	agentStarts: number;
} {
	const record = { starts: [] as CompactionStartEvent[], ends: [] as CompactionEndEvent[], agentStarts: 0 };
	harness.subscribe((event) => {
		if (event.type === "compaction_start") record.starts.push(event);
		else if (event.type === "compaction_end") record.ends.push(event);
		else if (event.type === "agent_start") record.agentStarts++;
	});
	return record;
}

// An overflow-shaped error message: matches isContextOverflow's "prompt is too long" pattern.
const overflowError = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 999 tokens > 100 maximum" });

describe("AgentHarness auto-compaction", () => {
	it("compacts on threshold without retrying", async () => {
		// A huge reserveTokens forces shouldCompact true for any successful turn.
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 200000, keepRecentTokens: 20000 },
		});
		registration.setResponses([() => fauxAssistantMessage("ok"), SUMMARY_RESPONSE]);
		const events = collectCompactionEvents(harness);

		await harness.prompt("hello");

		expect(events.starts.map((e) => e.reason)).toEqual(["threshold"]);
		expect(events.ends).toHaveLength(1);
		expect(events.ends[0]).toMatchObject({ reason: "threshold", aborted: false, willRetry: false });
		expect(events.ends[0]?.result).toBeDefined();
		// Threshold compaction does not re-enter the loop, so only the initial turn ran.
		expect(events.agentStarts).toBe(1);
	});

	it("recovers from a context overflow by compacting and retrying exactly once", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});
		registration.setResponses([overflowError, SUMMARY_RESPONSE, () => fauxAssistantMessage("recovered")]);
		const events = collectCompactionEvents(harness);

		const result = await harness.prompt("hello");

		expect(events.starts.map((e) => e.reason)).toEqual(["overflow"]);
		expect(events.ends).toHaveLength(1);
		expect(events.ends[0]).toMatchObject({ reason: "overflow", aborted: false, willRetry: true });
		// Two agent loops ran: the overflowing turn and the post-compaction retry.
		expect(events.agentStarts).toBe(2);
		expect(result.stopReason).not.toBe("error");
	});

	it("stops after one overflow recovery attempt without looping", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});
		// The retry overflows again; the one-shot latch must prevent a second compaction. The retry
		// carries a clearly-later timestamp so it sits after the just-written compaction boundary
		// (in production the retry is seconds later; the test would otherwise collide in one millisecond).
		const laterOverflow = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 999 tokens > 100 maximum",
				timestamp: 4102444800000,
			});
		registration.setResponses([overflowError, SUMMARY_RESPONSE, laterOverflow]);
		const events = collectCompactionEvents(harness);

		await harness.prompt("hello");

		// Exactly one compaction ran (the first overflow); the second overflow only reports failure.
		expect(events.starts).toHaveLength(1);
		const failure = events.ends.find((e) => e.errorMessage !== undefined);
		expect(failure).toMatchObject({ reason: "overflow", willRetry: false });
		expect(failure?.errorMessage).toContain("Context overflow recovery failed after one");
		// The overflowing turn plus one retry — no third loop.
		expect(events.agentStarts).toBe(2);
	});

	it("emits no compaction events when auto-compaction is disabled", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: false, reserveTokens: 200000, keepRecentTokens: 20000 },
		});
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const events = collectCompactionEvents(harness);

		await harness.prompt("hello");

		expect(events.starts).toHaveLength(0);
		expect(events.ends).toHaveLength(0);
		expect(events.agentStarts).toBe(1);
	});

	it("brackets a manual compact() with manual start/end and returns its result", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});
		// First a normal turn (no auto-compaction at this contextWindow), then the manual summary.
		registration.setResponses([() => fauxAssistantMessage("ok"), SUMMARY_RESPONSE]);
		await harness.prompt("hello");
		const events = collectCompactionEvents(harness);

		const result = await harness.compact("focus here");

		expect(result.summary.length).toBeGreaterThan(0);
		expect(events.starts).toEqual([{ type: "compaction_start", reason: "manual" }]);
		expect(events.ends).toHaveLength(1);
		expect(events.ends[0]).toMatchObject({ reason: "manual", aborted: false, willRetry: false });
		expect(events.ends[0]?.result?.summary).toBe(result.summary);
	});

	it("reports a cancelled manual compaction when abortCompaction() fires", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});
		// The summary response is suspended so abortCompaction lands while compaction is in flight.
		let releaseSummary: (() => void) | undefined;
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		registration.setResponses([
			() => fauxAssistantMessage("ok"),
			async () => {
				await summaryReleased;
				return fauxAssistantMessage("## Goal\nsummary");
			},
		]);
		await harness.prompt("hello");
		const events = collectCompactionEvents(harness);

		const compactPromise = harness.compact();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(harness.isCompacting).toBe(true);
		harness.abortCompaction();
		releaseSummary?.();
		await expect(compactPromise).rejects.toBeDefined();

		expect(events.ends).toHaveLength(1);
		expect(events.ends[0]).toMatchObject({ reason: "manual", aborted: true });
		expect(harness.isCompacting).toBe(false);
	});

	it("queues a message typed during compaction and emits a queue update", async () => {
		const { harness, registration } = createHarness({
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});
		let releaseSummary: (() => void) | undefined;
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		registration.setResponses([
			() => fauxAssistantMessage("ok"),
			async () => {
				await summaryReleased;
				return fauxAssistantMessage("## Goal\nsummary");
			},
		]);
		await harness.prompt("hello");
		const steerLengths: number[] = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") steerLengths.push(event.steer.length);
		});

		const compactPromise = harness.compact();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await harness.steer("typed during compaction");
		expect(harness.getSteeringMessages().map((m) => m.role)).toEqual(["user"]);
		releaseSummary?.();
		await compactPromise;

		expect(steerLengths).toContain(1);
	});
});
