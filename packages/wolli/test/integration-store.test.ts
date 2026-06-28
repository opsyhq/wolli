/**
 * Per-service integration state store — the `ctx.store` foundation.
 *
 * The in-memory backend covers the get/set/getAll/delete surface; the file backend
 * (under a temp `WOLLI_HOME`) covers the two properties the scheduler relies on:
 * one file per service, and a write that merges against the fresh on-disk copy so a
 * second writer to the same file can't clobber the first.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_HOME, getIntegrationStorePath } from "../src/config.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";

describe("integration store (in-memory)", () => {
	it("round-trips get / set / getAll / delete", () => {
		const store = IntegrationStore.inMemory();

		expect(store.get("svc", "a")).toBeUndefined();
		store.set("svc", "a", 1);
		store.set("svc", "b", { nested: true });
		expect(store.get("svc", "a")).toBe(1);
		expect(store.getAll("svc")).toEqual({ a: 1, b: { nested: true } });

		store.delete("svc", "a");
		expect(store.get("svc", "a")).toBeUndefined();
		expect(store.getAll("svc")).toEqual({ b: { nested: true } });
	});

	it("seeds each service independently", () => {
		const store = IntegrationStore.inMemory({ alpha: { k: 1 }, beta: { k: 2 } });
		expect(store.getAll("alpha")).toEqual({ k: 1 });
		expect(store.getAll("beta")).toEqual({ k: 2 });
		// getAll returns a copy — mutating it must not leak back into the store.
		store.getAll("alpha").k = 99;
		expect(store.get("alpha", "k")).toBe(1);
	});
});

describe("integration store (file-backed)", () => {
	const AGENT = "store-test-agent";
	let home: string;
	let priorHome: string | undefined;

	beforeEach(() => {
		priorHome = process.env[ENV_HOME];
		home = mkdtempSync(join(tmpdir(), "wolli-store-home-"));
		process.env[ENV_HOME] = home;
	});

	afterEach(() => {
		if (priorHome === undefined) delete process.env[ENV_HOME];
		else process.env[ENV_HOME] = priorHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("writes one file per service", () => {
		const store = IntegrationStore.create(AGENT);
		store.set("alpha", "k", 1);
		store.set("beta", "k", 2);

		expect(existsSync(getIntegrationStorePath(AGENT, "alpha"))).toBe(true);
		expect(existsSync(getIntegrationStorePath(AGENT, "beta"))).toBe(true);
		expect(store.getAll("alpha")).toEqual({ k: 1 });
		expect(store.getAll("beta")).toEqual({ k: 2 });
	});

	it("merges a write against the fresh on-disk copy (no lost update)", () => {
		const a = IntegrationStore.create(AGENT);
		const b = IntegrationStore.create(AGENT);
		// Prime both caches as empty, so each set must re-read disk under lock to merge.
		a.getAll("svc");
		b.getAll("svc");

		a.set("svc", "x", 1);
		b.set("svc", "y", 2);

		// b's write read a's `x` back from disk before merging, so neither key is lost.
		expect(b.getAll("svc")).toEqual({ x: 1, y: 2 });
		// A fresh reader sees the merged file on disk.
		expect(IntegrationStore.create(AGENT).getAll("svc")).toEqual({ x: 1, y: 2 });
	});
});
