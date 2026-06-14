/**
 * Reader for the shared pi settings.json (~/.steward/agent/settings.json).
 *
 * Mirrors `@opsyhq/coding-agent`'s `SettingsManager.getDefaultProvider()`/
 * `getDefaultModel()` getters but stays minimal: a plain read of the file the pi
 * CLI already wrote, no schema and no writer. Steward only needs the default
 * provider/model to seed model resolution when neither `--model` nor agent.json
 * specifies one.
 */

import { existsSync, readFileSync } from "node:fs";
import { getSettingsPath } from "../config.ts";

interface SharedSettings {
	defaultProvider?: string;
	defaultModel?: string;
}

// Parsed once per process and reused, mirroring coding-agent's SettingsManager
// (which parses in its constructor) so the getters are cheap field reads rather
// than a fresh disk read each. The CLI reads this file once at startup.
let cachedSettings: SharedSettings | undefined;

function readSettings(): SharedSettings {
	if (cachedSettings) return cachedSettings;
	const path = getSettingsPath();
	if (!existsSync(path)) {
		cachedSettings = {};
		return cachedSettings;
	}
	try {
		cachedSettings = JSON.parse(readFileSync(path, "utf-8")) as SharedSettings;
	} catch {
		cachedSettings = {};
	}
	return cachedSettings;
}

export function getDefaultProvider(): string | undefined {
	return readSettings().defaultProvider;
}

export function getDefaultModel(): string | undefined {
	return readSettings().defaultModel;
}
