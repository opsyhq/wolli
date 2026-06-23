/**
 * Real-docker integration: the createDockerEnvironment exec + file round-trip and the read
 * boundary. Skipped where docker is unavailable (not installed / no running daemon), so it is a
 * no-op in CI but a real check on a dev machine with docker up. Unlike environments.test.ts, this
 * file does NOT mock container.ts — it drives the actual docker CLI (and provisions rg/fd).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainerConfig, isContainerSupported, stopContainer } from "../src/core/environments/container.ts";
import { createDockerEnvironment } from "../src/core/environments/docker.ts";
import type { Environment } from "../src/core/environments/types.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { spawnProcessSync } from "../src/utils/child-process.ts";

const dockerAvailable = await isContainerSupported();

function firstText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && block.type === "text" ? (block.text ?? "") : "";
}

describe.skipIf(!dockerAvailable)("docker real isolation", () => {
	let dir: string;
	let outsideDir: string;
	let outsideFile: string;
	let env: Environment;
	let rgProvisioned = false;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "steward-docker-"));
		// A host file OUTSIDE the agent dir (its temp parent is not bind-mounted) — the container must
		// not be able to see it.
		outsideDir = mkdtempSync(join(tmpdir(), "steward-outside-"));
		outsideFile = join(outsideDir, "secret.txt");
		writeFileSync(outsideFile, "host-only-secret");
		env = await createDockerEnvironment(dir);
		// Provisioning needs network; gate the grep/find cases on it so an offline run skips rather
		// than fails. exec exits 0 when rg is on PATH inside the container.
		rgProvisioned = (await env.exec("command -v rg >/dev/null", env.cwd, { onData: () => {} })).exitCode === 0;
	}, 300_000);

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
		if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
	});

	it("runs a command in the container and persists writes to the bind-mounted dir", async () => {
		let out = "";
		const echo = await env.exec("echo hi", env.cwd, {
			onData: (data) => {
				out += data.toString();
			},
		});
		expect(echo.exitCode).toBe(0);
		expect(out.trim()).toBe("hi");

		// bash writes inside the container; the host sees it through the mount — the agent's home stays
		// visible host-side so the daemon's resource loader can pick up self-edits on reload.
		const write = await env.exec("echo persisted > marker.txt", env.cwd, { onData: () => {} });
		expect(write.exitCode).toBe(0);
		expect(await readFile(join(dir, "marker.txt"), "utf-8")).toBe("persisted\n");
	}, 180_000);

	it("routes file ops through the container and persists them to the mounted home", async () => {
		await env.writeFile(join(dir, "note.txt"), "hello-from-tool");
		// Read it back through the container...
		expect((await env.readFile(join(dir, "note.txt"))).toString()).toBe("hello-from-tool");
		// ...and host-side through the mount (reload can see it).
		expect(await readFile(join(dir, "note.txt"), "utf-8")).toBe("hello-from-tool");
		// stat / readdir / exists answer from the container.
		expect((await env.stat(join(dir, "note.txt"))).isFile()).toBe(true);
		expect(await env.readdir(dir)).toContain("note.txt");
		expect(await env.exists(join(dir, "note.txt"))).toBe(true);
	}, 180_000);

	it("reads the container's own FS, not the host, for absolute paths", async () => {
		// /etc/hostname exists in the container image but is the container's, not the host's.
		expect(await env.exists("/etc/hostname")).toBe(true);
		expect((await env.readFile("/etc/hostname")).length).toBeGreaterThan(0);
	}, 180_000);

	it("cannot see host files outside the bind-mounted agent dir", async () => {
		expect(await env.exists(outsideFile)).toBe(false);
		await expect(env.readFile(outsideFile)).rejects.toThrow();
	}, 180_000);

	it("runs grep inside the container, against container files only", async ({ skip }) => {
		if (!rgProvisioned) skip();
		await env.writeFile(join(dir, "haystack.txt"), "find the needle here\n");
		const result = await createGrepTool(env).execute("c1", { pattern: "needle" });
		expect(firstText(result)).toContain("haystack.txt");
		expect(firstText(result)).toContain("needle");
	}, 180_000);

	it("runs find inside the container, against container files only", async ({ skip }) => {
		if (!rgProvisioned) skip();
		await env.writeFile(join(dir, "locate-me.md"), "x");
		const result = await createFindTool(env).execute("c1", { pattern: "*.md" });
		expect(firstText(result)).toContain("locate-me.md");
	}, 180_000);
});
