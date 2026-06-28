// Prefix reduction, the allow -> isAllowed round-trip, and on-disk persistence (WOLLI_HOME
// redirected to a temp dir so ApprovalStore.create writes there).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentApprovalsPath } from "../src/config.ts";
import { type AgentApprovals, ApprovalStore, toPrefix } from "../src/core/approval/approval-storage.ts";

describe("toPrefix", () => {
	it("reduces by the arity table", () => {
		expect(toPrefix("git push origin main")).toEqual(["git", "push"]);
		expect(toPrefix("npm run build --watch")).toEqual(["npm", "run", "build"]);
		expect(toPrefix("npm install left-pad")).toEqual(["npm", "install"]);
		expect(toPrefix("docker compose up -d")).toEqual(["docker", "compose", "up"]);
		expect(toPrefix("cargo build --release")).toEqual(["cargo", "build"]);
	});

	it("defaults unknown programs to the program token", () => {
		expect(toPrefix("ls -la /tmp")).toEqual(["ls"]);
		expect(toPrefix("prettier --write .")).toEqual(["prettier"]);
	});

	it("refuses bare interpreters (codex banned-prefix denylist)", () => {
		expect(toPrefix("bash -c 'rm -rf /'")).toBeNull();
		expect(toPrefix("sh script.sh")).toBeNull();
		expect(toPrefix("sudo systemctl restart nginx")).toBeNull();
		expect(toPrefix("node -e 'process.exit()'")).toBeNull();
		expect(toPrefix("env FOO=1 bar")).toBeNull();
	});

	it("refuses compound / redirecting / subshell commands", () => {
		expect(toPrefix("echo hi | grep h")).toBeNull();
		expect(toPrefix("git push && rm -rf /")).toBeNull();
		expect(toPrefix("cat a > b")).toBeNull();
		expect(toPrefix("echo $(whoami)")).toBeNull();
		expect(toPrefix("foo; bar")).toBeNull();
	});

	it("refuses empty input", () => {
		expect(toPrefix("")).toBeNull();
		expect(toPrefix("   ")).toBeNull();
	});
});

describe("ApprovalStore matching", () => {
	it("allows a later command in the same family, re-prompts others", () => {
		const store = ApprovalStore.inMemory();
		store.allow("git push origin main", "host");

		expect(store.isAllowed("host", "git push origin develop")).toBe(true);
		expect(store.isAllowed("host", "git push")).toBe(true);
		expect(store.isAllowed("host", "git status")).toBe(false);
	});

	it("scopes rules to their target", () => {
		const store = ApprovalStore.inMemory();
		store.allow("git push origin main", "host");
		expect(store.isAllowed("sandbox", "git push origin main")).toBe(false);
	});

	it("never matches a compound command against a stored prefix", () => {
		const store = ApprovalStore.inMemory();
		store.allow("git push origin main", "host");
		// A `git push` rule must not silently green-light an appended `rm -rf /`.
		expect(store.isAllowed("host", "git push && rm -rf /")).toBe(false);
	});

	it("never persists a non-rememberable command", () => {
		const store = ApprovalStore.inMemory();
		store.allow("bash -c 'rm -rf /'", "host");
		store.allow("echo hi | grep h", "host");
		expect(store.getRules()).toEqual([]);
	});

	it("does not duplicate an already-stored rule", () => {
		const store = ApprovalStore.inMemory();
		store.allow("git push origin main", "host");
		store.allow("git push something else", "host");
		expect(store.getRules()).toHaveLength(1);
	});

	it("canRemember mirrors toPrefix", () => {
		const store = ApprovalStore.inMemory();
		expect(store.canRemember("git push origin main")).toBe(true);
		expect(store.canRemember("bash -c x")).toBe(false);
		expect(store.canRemember("a | b")).toBe(false);
	});
});

describe("ApprovalStore persistence", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "wolli-approvals-"));
		process.env.WOLLI_HOME = home;
	});

	afterEach(() => {
		delete process.env.WOLLI_HOME;
		rmSync(home, { recursive: true, force: true });
	});

	it("writes a versioned rule file at getAgentApprovalsPath", () => {
		const store = ApprovalStore.create("scribe");
		store.allow("git push origin main", "host");

		const onDisk = JSON.parse(readFileSync(getAgentApprovalsPath("scribe"), "utf-8")) as AgentApprovals;
		expect(onDisk.schemaVersion).toBe(1);
		expect(onDisk.rules).toHaveLength(1);
		expect(onDisk.rules[0]).toMatchObject({ target: "host", prefix: ["git", "push"] });
		expect(typeof onDisk.rules[0].createdAt).toBe("number");
	});

	it("survives a reload (a fresh store sees the persisted rule)", () => {
		ApprovalStore.create("scribe").allow("git push origin main", "host");
		const reloaded = ApprovalStore.create("scribe");
		expect(reloaded.isAllowed("host", "git push origin main")).toBe(true);
	});
});
