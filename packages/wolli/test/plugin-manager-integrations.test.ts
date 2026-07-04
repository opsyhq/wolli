/**
 * Integrations as a first-class plugin resource in `DefaultPluginManager`, plus the
 * managed `.plugins/` install layout.
 *
 * These cover the invariants of the self-contained-integration model and the on-disk store:
 *  - a channel plugin (one manifest declaring both `wolli.integrations` and
 *    `wolli.workflows`) resolves BOTH halves from a single managed copy under
 *    `.plugins/local/<key>/`, each carrying plugin metadata (`origin: "package"`);
 *  - `local:` sources are copied into the agent home so they survive the origin moving away;
 *  - `<agentDir>/integrations/` is auto-discovered like extensions;
 *  - install/persist is per-agent: it writes only the named agent's `agent.json` settings,
 *    never a sibling agent's, and the persisted local source round-trips through resolve;
 *  - managed npm/git installs land under `.plugins/`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getAgentDir } from "../src/config.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { DefaultPluginManager } from "../src/core/plugin-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

let tempDir: string;
let agentDir: string;
let previousOfflineEnv: string | undefined;
// Counter keeps temp dirs unique without Date.now()/Math.random().
let tempDirCounter = 0;

beforeEach(() => {
	previousOfflineEnv = process.env.WOLLI_OFFLINE;
	// Resolution must never reach the network for these local-only fixtures.
	process.env.WOLLI_OFFLINE = "1";
	tempDir = join(tmpdir(), `pm-int-${process.pid}-${tempDirCounter++}`);
	mkdirSync(tempDir, { recursive: true });
	process.env.WOLLI_HOME = tempDir;
	// Isolate the shared defaults to an (empty) temp dir so the merge can't pick up the
	// real user's ~/.wolli/agent/settings.json.
	process.env.WOLLI_SHARED_DIR = join(tempDir, "shared");
	AgentSettingsManager.createAgent({ name: "alice" });
	agentDir = getAgentDir("alice");
});

afterEach(() => {
	delete process.env.WOLLI_HOME;
	delete process.env.WOLLI_SHARED_DIR;
	if (previousOfflineEnv === undefined) {
		delete process.env.WOLLI_OFFLINE;
	} else {
		process.env.WOLLI_OFFLINE = previousOfflineEnv;
	}
	rmSync(tempDir, { recursive: true, force: true });
});

/** A self-contained channel package whose one manifest declares both halves. */
function writeDualHalfPackage(dir: string): { integrationPath: string; workflowPath: string } {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "telegram-channel",
			wolli: { integrations: ["./index.ts"], workflows: ["./telegram-inbound.ts"] },
		}),
	);
	writeFileSync(join(dir, "index.ts"), "export default function () {}");
	writeFileSync(join(dir, "telegram-inbound.ts"), "export default function () {}");
	// A sibling file declared by neither half must not be surfaced.
	writeFileSync(join(dir, "helper.ts"), "export const x = 1;");
	return { integrationPath: join(dir, "index.ts"), workflowPath: join(dir, "telegram-inbound.ts") };
}

describe("DefaultPluginManager — integrations as a plugin resource", () => {
	it("copies both halves of a channel plugin into .plugins/local/, each with origin: package", async () => {
		const pkgDir = join(tempDir, "telegram-pkg");
		writeDualHalfPackage(pkgDir);

		const settingsManager = AgentSettingsManager.create("alice");
		settingsManager.setPlugins([pkgDir]);
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		const result = await pm.resolve();

		const integration = result.integrations.find((r) => r.path.endsWith("index.ts"));
		const workflow = result.workflows.find((r) => r.path.endsWith("telegram-inbound.ts"));

		// Both halves surface, both enabled, both resolved from the same managed copy.
		expect(integration?.enabled).toBe(true);
		expect(workflow?.enabled).toBe(true);
		expect(integration?.metadata.origin).toBe("package");
		expect(workflow?.metadata.origin).toBe("package");

		// The copy lives under <agentDir>/.plugins/local/<key>/ — a single install for both halves,
		// pointed at the store rather than the origin dir.
		const localRoot = join(agentDir, ".plugins", "local");
		const store = integration?.metadata.baseDir;
		expect(store).toBeDefined();
		expect(store?.startsWith(localRoot)).toBe(true);
		expect(workflow?.metadata.baseDir).toBe(store);
		expect(integration?.path.startsWith(localRoot)).toBe(true);
		expect(workflow?.path.startsWith(localRoot)).toBe(true);
		expect(integration?.path.startsWith(pkgDir)).toBe(false);

		// The store is a real copy of the origin, and the origin still exists independently.
		expect(existsSync(join(store!, "index.ts"))).toBe(true);
		expect(existsSync(join(store!, "telegram-inbound.ts"))).toBe(true);
		expect(existsSync(pkgDir)).toBe(true);

		// The undeclared sibling is surfaced by neither half.
		expect(result.integrations.some((r) => r.path.endsWith("helper.ts"))).toBe(false);
		expect(result.workflows.some((r) => r.path.endsWith("helper.ts"))).toBe(false);
	});

	it("keeps a local source loadable after its origin is removed (the copy travels)", async () => {
		const pkgDir = join(tempDir, "local-ext");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "index.ts"), "export default function () {}");

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		await pm.installAndPersist(pkgDir);

		// install copied the origin into the managed local store; getInstalledPath points at it.
		const localRoot = join(agentDir, ".plugins", "local");
		const installedPath = pm.getInstalledPath(pkgDir);
		expect(installedPath).toBeDefined();
		expect(installedPath?.startsWith(localRoot)).toBe(true);
		expect(existsSync(join(installedPath!, "index.ts"))).toBe(true);

		// Delete the origin: a relocated agent has no remote to re-fetch from, so the copy
		// is the only copy — it must still resolve. A bare directory source surfaces as the
		// store dir itself (the loader resolves its index.ts entry).
		rmSync(pkgDir, { recursive: true, force: true });
		const result = await pm.resolve();
		const ext = result.extensions.find((r) => r.path.startsWith(localRoot));
		expect(ext).toBeDefined();
		expect(existsSync(join(ext!.path, "index.ts"))).toBe(true);
	});

	it("getInstalledPath finds a local source installed by a relative path (resolves against cwd, not the agent home)", async () => {
		// A plugin dir under the cwd, installed the way a user types it: "./rel-ext" (relative to cwd).
		// install keys the managed copy off the cwd-resolved origin; getInstalledPath must do the same,
		// or plugin-scoped onboarding can't match the installed integration and silently configures nothing.
		const pkgDir = join(tempDir, "rel-ext");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "index.ts"), "export default function () {}");

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		await pm.installAndPersist("./rel-ext");

		const localRoot = join(agentDir, ".plugins", "local");
		const installedPath = pm.getInstalledPath("./rel-ext");
		expect(installedPath).toBeDefined();
		expect(installedPath?.startsWith(localRoot)).toBe(true);
		expect(existsSync(join(installedPath!, "index.ts"))).toBe(true);
	});

	it("auto-discovers integrations from <agentDir>/integrations/", async () => {
		const intDir = join(agentDir, "integrations");
		mkdirSync(intDir, { recursive: true });
		const intPath = join(intDir, "weather.ts");
		writeFileSync(intPath, "export default function () {}");

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		const result = await pm.resolve();

		const discovered = result.integrations.find((r) => r.path === intPath);
		expect(discovered?.enabled).toBe(true);
		expect(discovered?.metadata.source).toBe("auto");
		expect(discovered?.metadata.origin).toBe("top-level");
	});

	it("auto-discovers tools from <agentDir>/tools/, skipping subdir helper files without an index", async () => {
		const toolsDir = join(agentDir, "tools");
		mkdirSync(join(toolsDir, "helpers"), { recursive: true });
		const toolPath = join(toolsDir, "echo.ts");
		writeFileSync(toolPath, "export default function () {}");
		// A helper module in a subdirectory with no index.ts must not surface as a tool.
		writeFileSync(join(toolsDir, "helpers", "util.ts"), "export const x = 1;");

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		const result = await pm.resolve();

		const discovered = result.tools.find((r) => r.path === toolPath);
		expect(discovered?.enabled).toBe(true);
		expect(discovered?.metadata.source).toBe("auto");
		expect(discovered?.metadata.origin).toBe("top-level");
		expect(result.tools.some((r) => r.path.endsWith("util.ts"))).toBe(false);
	});

	it("stamps a materialized package's integration with the original package dir's name", async () => {
		// A local package is copied to a hash-suffixed store dir (`.plugins/local/telegram-<hash>/`),
		// so the loader's basename rule alone would stamp `telegram-<hash>` as the service. The
		// resource loader must thread the ORIGINAL source dir's name through instead.
		const pkgDir = join(tempDir, "telegram");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "telegram-plugin", wolli: { integrations: ["./index.ts"] } }),
		);
		writeFileSync(
			join(pkgDir, "index.ts"),
			`
import { defineIntegration } from "wolli";

export default defineIntegration({});
`,
		);

		const settingsManager = AgentSettingsManager.create("alice");
		settingsManager.setPlugins([pkgDir]);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();

		const { integrations, errors } = loader.getIntegrations();
		expect(errors).toEqual([]);
		expect(integrations).toHaveLength(1);
		// The fixture really exercised the materialized case: the entry lives in a hash-suffixed store dir…
		expect(basename(dirname(integrations[0].resolvedPath))).toMatch(/^telegram-[0-9a-f]{12}$/);
		// …yet the stamped service is the original package dir's name.
		expect(integrations[0].service).toBe("telegram");
	});

	it("persists installs to the named agent's agent.json only, and round-trips on resolve", async () => {
		const pkgDir = join(tempDir, "telegram-pkg");
		writeDualHalfPackage(pkgDir);

		// A sibling agent home that must stay untouched by alice's install.
		const otherAgentDir = join(tempDir, "agents", "bob");
		mkdirSync(otherAgentDir, { recursive: true });

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		await pm.installAndPersist(pkgDir);

		// Persisted to alice's agent.json settings override only.
		const persisted = JSON.parse(readFileSync(getAgentConfigPath("alice"), "utf-8"));
		expect(persisted.settings.plugins).toHaveLength(1);

		// Bob's home is untouched — no agent.json leaked into a sibling agent.
		expect(existsSync(join(otherAgentDir, "agent.json"))).toBe(false);

		// The persisted local source round-trips: a fresh manager reading the same agent.json
		// resolves the integration half from the managed copy.
		const reread = AgentSettingsManager.create("alice");
		const pm2 = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager: reread });
		const result = await pm2.resolve();
		const integration = result.integrations.find((r) => r.path.endsWith("index.ts"));
		expect(integration?.enabled).toBe(true);
		expect(integration?.metadata.origin).toBe("package");
		expect(integration?.metadata.baseDir?.startsWith(join(agentDir, ".plugins", "local"))).toBe(true);
	});

	it("removing a local source deletes its managed store copy", async () => {
		const pkgDir = join(tempDir, "local-ext");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "index.ts"), "export default function () {}");

		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		await pm.installAndPersist(pkgDir);
		const installedPath = pm.getInstalledPath(pkgDir);
		expect(installedPath && existsSync(installedPath)).toBe(true);

		const removed = await pm.removeAndPersist(pkgDir);
		expect(removed).toBe(true);
		expect(existsSync(installedPath!)).toBe(false);
	});

	it("lands managed npm and git installs under .plugins/", () => {
		const settingsManager = AgentSettingsManager.create("alice");
		const pm = new DefaultPluginManager({ cwd: tempDir, agentDir, settingsManager });

		// Simulate installed npm + git trees under the managed store layout.
		const npmPkgDir = join(agentDir, ".plugins", "npm", "node_modules", "demo-ext");
		mkdirSync(npmPkgDir, { recursive: true });
		writeFileSync(join(npmPkgDir, "package.json"), JSON.stringify({ name: "demo-ext", version: "1.0.0" }));

		const gitPkgDir = join(agentDir, ".plugins", "git", "github.com", "acme", "demo");
		mkdirSync(gitPkgDir, { recursive: true });

		expect(pm.getInstalledPath("npm:demo-ext")).toBe(npmPkgDir);
		expect(pm.getInstalledPath("git:github.com/acme/demo")).toBe(gitPkgDir);
	});
});
