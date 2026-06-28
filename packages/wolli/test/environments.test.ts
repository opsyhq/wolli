/**
 * The Environment seam — backend selection (WOLLI_SANDBOX override + platform
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
import { createBypassGate } from "../src/core/approval/approval-gate.ts";
import type { ApprovalGate } from "../src/core/approval/types.ts";
import { startContainer } from "../src/core/environments/container.ts";
import { createDockerEnvironment } from "../src/core/environments/docker.ts";
import { createHostEnvironment } from "../src/core/environments/host.ts";
import { createEnvironments, createGatedEnvironment } from "../src/core/environments/index.ts";
import { createLocalOSEnvironment } from "../src/core/environments/local-os.ts";
import { createSandbox, isSandboxSupported } from "../src/core/environments/sandbox.ts";
import type { Environment } from "../src/core/environments/types.ts";

// The env layer only enforces a gate it is handed; tests pass a fail-closed stub.
const denyGate: ApprovalGate = async () => ({ allowed: false, reason: "no approval response" });
const mkEnvs = (agentDir = "/tmp/some-agent", gate: ApprovalGate = denyGate) => createEnvironments(agentDir, { gate });

vi.mock("../src/core/environments/sandbox.ts", () => ({
	isSandboxSupported: vi.fn(() => true),
	createSandboxConfig: vi.fn(() => ({})),
	createSandbox: vi.fn(async () => ({ wrap: async (command: string) => command, cleanupAfterCommand: () => {} })),
	resetSandbox: vi.fn(async () => {}),
}));

// Mock the docker primitive so selection/routing tests stay daemon-free; the real exec + file
// round-trip lives in environments-docker.test.ts (skipped where docker is unavailable). The file
// methods return sentinels so a test can prove createDockerEnvironment delegates to the container.
vi.mock("../src/core/environments/container.ts", () => ({
	isContainerSupported: vi.fn(async () => true),
	createContainerConfig: vi.fn((cwd: string) => ({ name: `sbx-${cwd}`, image: "img", cwd, configHash: "h" })),
	startContainer: vi.fn(async (config: { name: string }) => ({
		name: config.name,
		exec: async () => ({ exitCode: 0 }),
		readFile: async () => Buffer.from("from-container"),
		writeFile: async () => {},
		mkdir: async () => {},
		stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 0 }),
		readdir: async () => ["in-container.txt"],
		access: async () => {},
		exists: async () => true,
		detectImageMimeType: async () => null,
	})),
	stopContainer: vi.fn(async () => {}),
}));

beforeEach(() => {
	// Reset the per-test default; mockReturnValue survives clearAllMocks.
	vi.mocked(isSandboxSupported).mockReturnValue(true);
});

afterEach(() => {
	delete process.env[ENV_SANDBOX];
	vi.clearAllMocks();
});

describe("createEnvironments target selection", () => {
	it("pairs a silent confined sandbox with a gated host where srt is supported", async () => {
		const envs = await mkEnvs();
		expect(envs.default).toBe("sandbox");
		expect(envs.targets.sandbox.id).toBe("local-os");
		expect(envs.targets.host.id).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["sandbox", "host"]);
	});

	it("enforces the gate inside the host env's exec, not as an opt-in field", async () => {
		// denyGate refuses, so the host exec is blocked before it can spawn.
		const envs = await mkEnvs();
		await expect(envs.targets.host.exec("whoami", "/tmp", { onData: () => {} })).rejects.toThrow(
			/Escalation to host blocked/,
		);
		expect("approve" in envs.targets.host).toBe(false);
	});

	it("honors WOLLI_SANDBOX=local-os without consulting platform support", async () => {
		process.env[ENV_SANDBOX] = "local-os";
		const envs = await mkEnvs();
		expect(envs.default).toBe("sandbox");
		expect(envs.targets.sandbox.id).toBe("local-os");
	});

	it("auto and unset both confine where srt is supported", async () => {
		process.env[ENV_SANDBOX] = "auto";
		expect((await mkEnvs()).default).toBe("sandbox");
		delete process.env[ENV_SANDBOX];
		expect((await mkEnvs()).default).toBe("sandbox");
	});

	it("collapses to a single silent host target on WOLLI_SANDBOX=host, never touching srt", async () => {
		process.env[ENV_SANDBOX] = "host";
		const envs = await mkEnvs();
		expect(envs.default).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["host"]);
		expect(envs.targets.host.id).toBe("host");
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it("collapses to a single host target where srt is unsupported", async () => {
		vi.mocked(isSandboxSupported).mockReturnValue(false);
		const envs = await mkEnvs();
		expect(envs.default).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["host"]);
	});

	it("treats an unknown override as auto (platform default)", async () => {
		process.env[ENV_SANDBOX] = "garbage";
		vi.mocked(isSandboxSupported).mockReturnValue(false);
		expect((await mkEnvs()).default).toBe("host");
	});

	it("collapses to host when the sandbox backend fails to initialize", async () => {
		process.env[ENV_SANDBOX] = "local-os";
		vi.mocked(createSandbox).mockRejectedValueOnce(new Error("srt init boom"));
		const envs = await mkEnvs();
		expect(envs.default).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["host"]);
		expect(createSandbox).toHaveBeenCalled();
	});

	it("selects the docker backend on WOLLI_SANDBOX=docker", async () => {
		process.env[ENV_SANDBOX] = "docker";
		const envs = await mkEnvs();
		expect(envs.default).toBe("sandbox");
		expect(envs.targets.sandbox.id).toBe("docker");
		expect(envs.targets.host.id).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["sandbox", "host"]);
	});

	it("never selects docker for auto/unset — it is explicit opt-in only", async () => {
		process.env[ENV_SANDBOX] = "auto";
		expect((await mkEnvs()).targets.sandbox.id).toBe("local-os");
		delete process.env[ENV_SANDBOX];
		expect((await mkEnvs()).targets.sandbox.id).toBe("local-os");
		expect(startContainer).not.toHaveBeenCalled();
	});

	it("collapses to host when the docker backend fails to initialize", async () => {
		process.env[ENV_SANDBOX] = "docker";
		vi.mocked(startContainer).mockRejectedValueOnce(new Error("docker init boom"));
		const envs = await mkEnvs();
		expect(envs.default).toBe("host");
		expect(Object.keys(envs.targets)).toEqual(["host"]);
		expect(startContainer).toHaveBeenCalled();
	});
});

describe("createGatedEnvironment", () => {
	const baseEnv = (onExec: (command: string) => void): Environment =>
		({
			id: "host",
			cwd: "/work",
			exec: async (command: string) => {
				onExec(command);
				return { exitCode: 0 };
			},
		}) as unknown as Environment;

	it("runs the command, keyed by the base env id, when the gate allows it", async () => {
		const ran: string[] = [];
		let seen: { target: string; command: string } | undefined;
		const gated = createGatedEnvironment(
			baseEnv((c) => ran.push(c)),
			async (req) => {
				seen = { target: req.target, command: req.command };
				return { allowed: true, scope: "once" };
			},
		);

		await gated.exec("ls -la", "/work", { onData: () => {} });
		expect(ran).toEqual(["ls -la"]);
		expect(seen).toEqual({ target: "host", command: "ls -la" });
	});

	it("throws and never touches the base env when the gate refuses", async () => {
		const ran: string[] = [];
		const gated = createGatedEnvironment(
			baseEnv((c) => ran.push(c)),
			async () => ({ allowed: false, reason: "denied by user" }),
		);

		await expect(gated.exec("rm -rf /", "/work", { onData: () => {} })).rejects.toThrow(
			/Escalation to host blocked: denied by user/,
		);
		expect(ran).toEqual([]);
	});

	it("runs the command with the bypass gate without any UI prompt", async () => {
		const ran: string[] = [];
		const gated = createGatedEnvironment(
			baseEnv((c) => ran.push(c)),
			createBypassGate(),
		);

		await gated.exec("rm -rf /", "/work", { onData: () => {} });
		expect(ran).toEqual(["rm -rf /"]);
	});
});

describe("local write-jail", () => {
	let jail: string;
	let outside: string;

	beforeEach(() => {
		jail = mkdtempSync(join(tmpdir(), "wolli-jail-"));
		outside = mkdtempSync(join(tmpdir(), "wolli-outside-"));
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

// Daemon-owned control state lives under the jail root but must be write-denied to the agent's own
// file tools, so the agent can't self-approve a host escalation or tamper with session history.
describe("local control-state write-deny", () => {
	let jail: string;
	let denyWrite: string[];

	beforeEach(() => {
		jail = mkdtempSync(join(tmpdir(), "wolli-jail-"));
		denyWrite = [join(jail, "approvals.json"), join(jail, "sessions")];
	});

	afterEach(() => {
		rmSync(jail, { recursive: true, force: true });
	});

	it("rejects writing approvals.json (host-escalation self-approval)", async () => {
		const env = await createLocalOSEnvironment(jail, { denyWrite });
		await expect(env.writeFile(join(jail, "approvals.json"), "{}")).rejects.toThrow(/daemon-owned control state/);
	});

	it("allows writing agent.json (not denied)", async () => {
		const env = await createLocalOSEnvironment(jail, { denyWrite });
		await env.writeFile(join(jail, "agent.json"), "{}");
		expect(await readFile(join(jail, "agent.json"), "utf-8")).toBe("{}");
	});

	it("rejects writes under the sessions dir", async () => {
		const env = await createLocalOSEnvironment(jail, { denyWrite });
		await expect(env.writeFile(join(jail, "sessions", "s1.jsonl"), "{}")).rejects.toThrow(
			/daemon-owned control state/,
		);
	});

	it("rejects mkdir under the sessions dir", async () => {
		const env = await createLocalOSEnvironment(jail, { denyWrite });
		await expect(env.mkdir(join(jail, "sessions", "nested"))).rejects.toThrow(/daemon-owned control state/);
	});

	it("still allows writes to the agent's workspace", async () => {
		const env = await createLocalOSEnvironment(jail, { denyWrite });
		await env.mkdir(join(jail, "workspace"));
		await env.writeFile(join(jail, "workspace", "note.txt"), "ok");
		expect(await readFile(join(jail, "workspace", "note.txt"), "utf-8")).toBe("ok");
	});
});

// The agent's home IS its $HOME on the confined target; the host escape keeps the user's real one.
// createSandbox is mocked to a passthrough, so exec runs the real shell with the injected env.
describe("local-os home env", () => {
	let jail: string;

	beforeEach(() => {
		jail = mkdtempSync(join(tmpdir(), "wolli-jail-"));
	});

	afterEach(() => {
		rmSync(jail, { recursive: true, force: true });
	});

	it("repoints $HOME to the agent home on the confined target", async () => {
		const env = await createLocalOSEnvironment(jail);
		let out = "";
		await env.exec('printf %s "$HOME"', jail, {
			onData: (data) => {
				out += data.toString();
			},
		});
		expect(out).toBe(jail);
	});

	it("leaves the host target's $HOME inherited from the user", async () => {
		const env = createHostEnvironment(jail);
		let out = "";
		await env.exec('printf %s "$HOME"', jail, {
			onData: (data) => {
				out += data.toString();
			},
		});
		expect(out).toBe(process.env.HOME);
	});
});

// Every docker file op runs inside the container (docker exec), not host-side node:fs, so the
// container boundary is the jail. We assert the Environment delegates to the container surface; the
// real confinement round-trip lives in environments-docker.test.ts. (container.ts is mocked here.)
describe("docker file ops route through the container", () => {
	it("keeps the host agent dir as cwd but reads through the container, not host node:fs", async () => {
		const env = await createDockerEnvironment("/some/agent/dir");
		expect(env.id).toBe("docker");
		expect(env.cwd).toBe("/some/agent/dir");
		// The mocked container returns a sentinel; a host node:fs read of this path would throw.
		expect((await env.readFile("/anything")).toString()).toBe("from-container");
		expect(await env.readdir("/anything")).toEqual(["in-container.txt"]);
	});
});
