/**
 * The Environment seam — backend selection (STEWARD_SANDBOX override + platform
 * default), the host-fallback when srt init fails, and the in-process write-jail
 * the local backend enforces on `write`/`edit`.
 *
 * The srt primitive (`sandbox.ts`) is mocked so the suite is deterministic and
 * srt-free on every platform: `createSandbox` yields a passthrough handle (no
 * real OS sandbox / proxy servers) and `isSandboxSupported` is controllable per
 * test. The logic under test — the kind selector, the try/catch fallback, and
 * the `getCwdRelativePath` containment guard — is real code, srt-independent.
 * srt's actual confinement is covered by the manual smoke test.
 */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_SANDBOX } from "../src/config.ts";
import { createEnvironment } from "../src/core/environments/index.ts";
import { createLocalOSEnvironment } from "../src/core/environments/local-os.ts";
import { createSandbox, isSandboxSupported } from "../src/core/environments/sandbox.ts";

vi.mock("../src/core/environments/sandbox.ts", () => ({
	isSandboxSupported: vi.fn(() => true),
	createSandboxConfig: vi.fn(() => ({})),
	createSandbox: vi.fn(async () => ({ wrap: async (command: string) => command, cleanupAfterCommand: () => {} })),
	resetSandbox: vi.fn(async () => {}),
}));

beforeEach(() => {
	// Reset the per-test default; mockReturnValue survives clearAllMocks.
	vi.mocked(isSandboxSupported).mockReturnValue(true);
});

afterEach(() => {
	delete process.env[ENV_SANDBOX];
	vi.clearAllMocks();
});

describe("createEnvironment backend selection", () => {
	it("honors an explicit STEWARD_SANDBOX=host override without touching srt", async () => {
		process.env[ENV_SANDBOX] = "host";
		const env = await createEnvironment("/tmp/some-agent");
		expect(env.id).toBe("host");
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it("honors an explicit STEWARD_SANDBOX=local-os override", async () => {
		process.env[ENV_SANDBOX] = "local-os";
		const env = await createEnvironment("/tmp/some-agent");
		expect(env.id).toBe("local-os");
	});

	it("auto (and unset) confines where srt is supported, else host", async () => {
		process.env[ENV_SANDBOX] = "auto";
		expect((await createEnvironment("/tmp/some-agent")).id).toBe("local-os");
		delete process.env[ENV_SANDBOX];
		expect((await createEnvironment("/tmp/some-agent")).id).toBe("local-os");
		vi.mocked(isSandboxSupported).mockReturnValue(false);
		expect((await createEnvironment("/tmp/some-agent")).id).toBe("host");
	});

	it("treats an unknown override as auto (platform default)", async () => {
		process.env[ENV_SANDBOX] = "garbage";
		vi.mocked(isSandboxSupported).mockReturnValue(false);
		expect((await createEnvironment("/tmp/some-agent")).id).toBe("host");
	});

	it("falls back to host when the local-os backend fails to initialize", async () => {
		process.env[ENV_SANDBOX] = "local-os";
		vi.mocked(createSandbox).mockRejectedValueOnce(new Error("srt init boom"));
		const env = await createEnvironment("/tmp/some-agent");
		expect(env.id).toBe("host");
	});
});

describe("local write-jail", () => {
	let jail: string;
	let outside: string;

	beforeEach(() => {
		jail = mkdtempSync(join(tmpdir(), "steward-jail-"));
		outside = mkdtempSync(join(tmpdir(), "steward-outside-"));
	});

	afterEach(() => {
		rmSync(jail, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("allows writes inside the jail root", async () => {
		const env = await createLocalOSEnvironment(jail);
		const target = join(jail, "note.txt");
		await env.writeFile(target, "hi");
		expect(await readFile(target, "utf-8")).toBe("hi");
	});

	it("rejects writes outside the jail root", async () => {
		const env = await createLocalOSEnvironment(jail);
		await expect(env.writeFile("/etc/should-not-write", "nope")).rejects.toThrow(/outside sandbox root/);
	});

	it("rejects mkdir outside the jail root", async () => {
		const env = await createLocalOSEnvironment(jail);
		await expect(env.mkdir("/etc/should-not-mkdir")).rejects.toThrow(/outside sandbox root/);
	});

	it("rejects writing through a symlink that points outside the jail", async () => {
		const env = await createLocalOSEnvironment(jail);
		const link = join(jail, "escape");
		symlinkSync(join(outside, "target.txt"), link);
		await expect(env.writeFile(link, "nope")).rejects.toThrow(/outside sandbox root/);
	});

	it("rejects writes under a symlinked directory that points outside the jail", async () => {
		const env = await createLocalOSEnvironment(jail);
		const linkedDir = join(jail, "linkdir");
		symlinkSync(outside, linkedDir);
		await expect(env.writeFile(join(linkedDir, "file.txt"), "nope")).rejects.toThrow(/outside sandbox root/);
	});
});
