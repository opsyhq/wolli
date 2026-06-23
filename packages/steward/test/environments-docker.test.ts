/**
 * Real-docker integration: the createDockerEnvironment exec round-trip. Skipped where
 * docker is unavailable (not installed / no running daemon), so it is a no-op in CI but
 * a real check on a dev machine with docker up. Unlike environments.test.ts, this file
 * does NOT mock container.ts — it drives the actual docker CLI.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createContainerConfig, isContainerSupported, stopContainer } from "../src/core/environments/container.ts";
import { createDockerEnvironment } from "../src/core/environments/docker.ts";
import { spawnProcessSync } from "../src/utils/child-process.ts";

const dockerAvailable = await isContainerSupported();

describe.skipIf(!dockerAvailable)("docker exec round-trip", () => {
	let dir: string | undefined;

	afterAll(async () => {
		if (dir) {
			await stopContainer(dir);
			// rm -f (not just the stop) so the test leaves no container behind.
			spawnProcessSync("docker", ["rm", "-f", createContainerConfig(dir).name], {
				encoding: "utf-8",
				stdio: "ignore",
			});
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a command in the container and persists writes to the bind-mounted dir", async () => {
		dir = mkdtempSync(join(tmpdir(), "steward-docker-"));
		const env = await createDockerEnvironment(dir);

		let out = "";
		const stdout = await env.exec("echo hi", dir, {
			onData: (data) => {
				out += data.toString();
			},
		});
		expect(stdout.exitCode).toBe(0);
		expect(out.trim()).toBe("hi");

		// bash writes inside the container; the host sees it through the mount — the whole
		// point of identical-path bind-mounting (workspace persistence is free).
		const write = await env.exec("echo persisted > marker.txt", dir, { onData: () => {} });
		expect(write.exitCode).toBe(0);
		expect(await readFile(join(dir, "marker.txt"), "utf-8")).toBe("persisted\n");
	}, 180_000);
});
