/**
 * Integrations as a first-class package resource in `DefaultPackageManager`.
 *
 * These cover the invariants of the self-contained-integration model:
 *  - a dual-half package (one manifest declaring both `steward.integrations` and
 *    `steward.extensions`) resolves BOTH halves in place from a single install, each
 *    carrying package metadata (`origin: "package"`) — no symlink, no file copy;
 *  - `<agentDir>/integrations/` is auto-discovered like extensions;
 *  - install/persist is per-agent: it writes only the named agent's `settings.json`,
 *    never a sibling agent's, and the persisted local source round-trips through resolve.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let tempDir: string;
let agentDir: string;
let previousOfflineEnv: string | undefined;
// Counter keeps temp dirs unique without Date.now()/Math.random().
let tempDirCounter = 0;

beforeEach(() => {
	previousOfflineEnv = process.env.STEWARD_OFFLINE;
	// Resolution must never reach the network for these local-only fixtures.
	process.env.STEWARD_OFFLINE = "1";
	tempDir = join(tmpdir(), `pm-int-${process.pid}-${tempDirCounter++}`);
	agentDir = join(tempDir, "agents", "alice");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	if (previousOfflineEnv === undefined) {
		delete process.env.STEWARD_OFFLINE;
	} else {
		process.env.STEWARD_OFFLINE = previousOfflineEnv;
	}
	rmSync(tempDir, { recursive: true, force: true });
});

/** A self-contained package whose one manifest declares both halves. */
function writeDualHalfPackage(dir: string): { integrationPath: string; extensionPath: string } {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "telegram-chat",
			steward: { integrations: ["./index.ts"], extensions: ["./telegram-chat.ts"] },
		}),
	);
	writeFileSync(join(dir, "index.ts"), "export default function () {}");
	writeFileSync(join(dir, "telegram-chat.ts"), "export default function () {}");
	// A sibling file declared by neither half must not be surfaced.
	writeFileSync(join(dir, "helper.ts"), "export const x = 1;");
	return { integrationPath: join(dir, "index.ts"), extensionPath: join(dir, "telegram-chat.ts") };
}

describe("DefaultPackageManager — integrations as a package resource", () => {
	it("resolves both halves of a dual-half package in place, each with origin: package", async () => {
		const pkgDir = join(tempDir, "telegram-pkg");
		const { integrationPath, extensionPath } = writeDualHalfPackage(pkgDir);

		const settingsManager = SettingsManager.inMemory({ packages: [pkgDir] });
		const pm = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });

		const result = await pm.resolve();

		const integration = result.integrations.find((r) => r.path === integrationPath);
		const extension = result.extensions.find((r) => r.path === extensionPath);

		// Both halves surface, both enabled, both resolved from the same install root.
		expect(integration?.enabled).toBe(true);
		expect(extension?.enabled).toBe(true);
		expect(integration?.metadata.origin).toBe("package");
		expect(extension?.metadata.origin).toBe("package");
		expect(integration?.metadata.baseDir).toBe(pkgDir);
		expect(extension?.metadata.baseDir).toBe(pkgDir);

		// The undeclared sibling is surfaced by neither half.
		expect(result.integrations.some((r) => r.path.endsWith("helper.ts"))).toBe(false);
		expect(result.extensions.some((r) => r.path.endsWith("helper.ts"))).toBe(false);
	});

	it("auto-discovers integrations from <agentDir>/integrations/", async () => {
		const intDir = join(agentDir, "integrations");
		mkdirSync(intDir, { recursive: true });
		const intPath = join(intDir, "weather.ts");
		writeFileSync(intPath, "export default function () {}");

		const settingsManager = SettingsManager.inMemory({});
		const pm = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });

		const result = await pm.resolve();

		const discovered = result.integrations.find((r) => r.path === intPath);
		expect(discovered?.enabled).toBe(true);
		expect(discovered?.metadata.source).toBe("auto");
		expect(discovered?.metadata.origin).toBe("top-level");
	});

	it("persists installs to the named agent's settings.json only, and round-trips on resolve", async () => {
		const pkgDir = join(tempDir, "telegram-pkg");
		const { integrationPath } = writeDualHalfPackage(pkgDir);

		// A sibling agent home that must stay untouched by alice's install.
		const otherAgentDir = join(tempDir, "agents", "bob");
		mkdirSync(otherAgentDir, { recursive: true });

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const pm = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });

		await pm.installAndPersist(pkgDir);

		// Persisted to alice's settings only.
		const aliceSettingsPath = join(agentDir, "settings.json");
		expect(existsSync(aliceSettingsPath)).toBe(true);
		const persisted = JSON.parse(readFileSync(aliceSettingsPath, "utf-8"));
		expect(persisted.packages).toHaveLength(1);

		// Bob's home is untouched — no settings.json leaked into a shared/other agent.
		expect(existsSync(join(otherAgentDir, "settings.json"))).toBe(false);

		// The persisted local source round-trips: a fresh manager reading the same
		// settings resolves the integration half in place.
		const reread = SettingsManager.create(tempDir, agentDir);
		const pm2 = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager: reread });
		const result = await pm2.resolve();
		const integration = result.integrations.find((r) => r.path === integrationPath);
		expect(integration?.enabled).toBe(true);
		expect(integration?.metadata.origin).toBe("package");
	});
});
