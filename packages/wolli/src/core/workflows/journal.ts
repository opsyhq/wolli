/**
 * Run journal: the append-only record stream of one workflow run.
 *
 * A journal is one run — constructing it opens the run (mints the UUIDv7 run id, records
 * run_start). Records accumulate in an internal array (the test seam) and, when a runs
 * directory is provided, mirror as JSON lines to a per-run debug log at
 * <runsDir>/<runId>.jsonl. The log is write-only in v1: no reader, no replay, no rotation;
 * appends are fire-and-forget and failures are swallowed, because the log must never break
 * a run.
 *
 * The record shape and checkpoint keying follow Absurd (github.com/earendil-works/absurd,
 * Apache-2.0): checkpointKey = step name + per-name occurrence counter, terminal statuses
 * ok|error|cancelled, {name, message, stack} errors, UUIDv7 run ids, and the full trigger
 * payload on run_start.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	RecordedError,
	RunEndRecord,
	RunRecord,
	RunStartRecord,
	RunStatus,
	RunTrigger,
	StepEndRecord,
	StepKind,
	StepStartRecord,
} from "./types.ts";

export interface RunJournalOptions {
	/** Workflow name (the file basename). */
	workflow: string;
	trigger: RunTrigger;
	/** Load-generation stamp. */
	generation: number;
	/** The provoking run/step, for workflow-triggers-workflow chains. */
	parentRunId?: string;
	causeStepId?: number;
	/** When set, every record also appends to <runsDir>/<runId>.jsonl. */
	runsDir?: string;
}

export interface StepOptions {
	/**
	 * Required so the authoring boundary declares it: ctx.step passes "user", the engine's
	 * recording helpers pass "auto" — a defaulted kind would silently mislabel one of them.
	 */
	kind: StepKind;
	args?: unknown;
	/** Makes this a nested child step: no checkpointKey, no counter effect. */
	parentStepId?: number;
}

export class RunJournal {
	readonly runId: string = uuidv7();
	private readonly _records: RunRecord[] = [];
	private readonly logPath: string | undefined;
	private nextStepId = 1;
	/** Per-name occurrence counters for checkpoint keys; top-level steps only. */
	private readonly nameCounts = new Map<string, number>();
	/** Serializes debug-log appends so lines land in record order. */
	private writeChain: Promise<void> = Promise.resolve();

	constructor(options: RunJournalOptions) {
		if (options.runsDir) {
			this.logPath = join(options.runsDir, `${this.runId}.jsonl`);
			this.writeChain = mkdir(options.runsDir, { recursive: true })
				.then(() => {})
				.catch(() => {});
		}
		const record: RunStartRecord = {
			type: "run_start",
			runId: this.runId,
			workflow: options.workflow,
			trigger: toSerializableTrigger(options.trigger),
			generation: options.generation,
			ts: Date.now(),
		};
		if (options.parentRunId !== undefined) record.parentRunId = options.parentRunId;
		if (options.causeStepId !== undefined) record.causeStepId = options.causeStepId;
		this.append(record);
	}

	/** The run's records so far, in append order. */
	get records(): readonly RunRecord[] {
		return this._records;
	}

	/** Opens a step and returns its sequential id. */
	startStep(name: string, options: StepOptions): number {
		const stepId = this.nextStepId++;
		const record: StepStartRecord = {
			type: "step_start",
			stepId,
			name,
			kind: options.kind,
			ts: Date.now(),
		};
		if (options.parentStepId !== undefined) {
			record.parentStepId = options.parentStepId;
		} else {
			const count = (this.nameCounts.get(name) ?? 0) + 1;
			this.nameCounts.set(name, count);
			record.checkpointKey = count === 1 ? name : `${name}#${count}`;
		}
		if (options.args !== undefined) record.args = toSerializable(options.args);
		this.append(record);
		return stepId;
	}

	endStep(stepId: number, outcome: { status: RunStatus; result?: unknown; error?: unknown }): void {
		const record: StepEndRecord = {
			type: "step_end",
			stepId,
			status: outcome.status,
			attempt: 1,
			ts: Date.now(),
		};
		if (outcome.result !== undefined) record.result = toSerializable(outcome.result);
		if (outcome.error !== undefined) record.error = toRecordedError(outcome.error);
		this.append(record);
	}

	/**
	 * Brackets `fn` in a recorded step: step_start, run, step_end with the result or the
	 * captured error (rethrown). Returns fn's live value; only the record is serialized.
	 */
	async step<T>(name: string, fn: () => T | Promise<T>, options: StepOptions): Promise<T> {
		const stepId = this.startStep(name, options);
		try {
			const result = await fn();
			this.endStep(stepId, { status: "ok", result });
			return result;
		} catch (error) {
			this.endStep(stepId, { status: "error", error });
			throw error;
		}
	}

	endRun(status: RunStatus, error?: unknown): void {
		const record: RunEndRecord = { type: "run_end", status, ts: Date.now() };
		if (error !== undefined) record.error = toRecordedError(error);
		this.append(record);
	}

	/** Resolves once every queued debug-log append has settled. */
	flush(): Promise<void> {
		return this.writeChain;
	}

	private append(record: RunRecord): void {
		this._records.push(record);
		const path = this.logPath;
		if (!path) return;
		const line = `${JSON.stringify(record)}\n`;
		this.writeChain = this.writeChain.then(() => appendFile(path, line)).catch(() => {});
	}
}

/**
 * JSON round-trip guard: recorded values must be data. A non-serializable value degrades
 * to a structurally unmistakable marker (the reserved `$unserializable` field) so a
 * future replay engine can refuse to memoize from it instead of resolving a step with
 * garbage.
 */
function toSerializable(value: unknown): unknown {
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return JSON.parse(json);
	} catch {
		// fall through to the marker
	}
	return {
		$unserializable: true,
		type: typeof value === "object" && value !== null ? (value.constructor?.name ?? "object") : typeof value,
	};
}

/**
 * Round-trips only the untrusted payload; the typed discriminant fields survive intact,
 * so run_start stays a re-drivable trigger even when the payload degrades to the marker.
 */
function toSerializableTrigger(trigger: RunTrigger): RunTrigger {
	return trigger.kind === "callable"
		? { ...trigger, input: toSerializable(trigger.input) }
		: { ...trigger, payload: toSerializable(trigger.payload) };
}

function toRecordedError(error: unknown): RecordedError {
	if (error instanceof Error) {
		const recorded: RecordedError = { name: error.name, message: error.message };
		if (error.stack !== undefined) recorded.stack = error.stack;
		return recorded;
	}
	return { name: "Error", message: String(error) };
}

/** UUIDv7: 48-bit millisecond timestamp, version/variant bits, 74 random bits. */
function uuidv7(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let ts = Date.now();
	for (let i = 5; i >= 0; i--) {
		bytes[i] = ts % 256;
		ts = Math.floor(ts / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
