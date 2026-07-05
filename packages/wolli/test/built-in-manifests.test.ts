/**
 * Built-in plugin manifest smoke test.
 *
 * The shipped plugin sources under `built-in/plugins/**` sit outside the root tsconfig
 * include and their transport deps (grammy, discord.js, croner) are not workspace deps,
 * so those files never typecheck or load in CI. This test is the only in-repo gate on
 * their manifests: it parses each `package.json`, asserts the `wolli` resource keys, and
 * checks that every listed contribution file exists on disk — catching a renamed file, a
 * stale manifest, or a leftover `extensions` key.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGINS_DIR = join(import.meta.dirname, "..", "built-in", "plugins");
const MODULE_KEYS = ["integrations", "workflows", "tools"] as const;

/** The resource files each shipped plugin must declare and provide. */
const EXPECTED: Record<string, { integrations: string[]; workflows: string[]; tools?: string[] }> = {
	telegram: {
		integrations: ["./index.ts"],
		workflows: ["./telegram-chat.ts"],
	},
	discord: {
		integrations: ["./index.ts"],
		workflows: ["./discord-chat.ts"],
	},
	scheduler: {
		integrations: ["./index.ts"],
		workflows: ["./scheduler-due.ts"],
		tools: ["./cron.ts"],
	},
};

describe("built-in plugin manifests", () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		describe(name, () => {
			const manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, name, "package.json"), "utf-8"));

			it("declares the expected wolli resource keys, the wolli peer, and no legacy extensions key", () => {
				expect(manifest.wolli).toBeDefined();
				expect(manifest.wolli.extensions).toBeUndefined();
				expect(manifest.wolli.integrations).toEqual(expected.integrations);
				expect(manifest.wolli.workflows).toEqual(expected.workflows);
				expect(manifest.wolli.tools).toEqual(expected.tools);
				expect(manifest.peerDependencies?.wolli).toBe("*");
			});

			it("provides every file listed under a module key", () => {
				for (const key of MODULE_KEYS) {
					for (const rel of manifest.wolli[key] ?? []) {
						expect(existsSync(join(PLUGINS_DIR, name, rel))).toBe(true);
					}
				}
			});
		});
	}
});
