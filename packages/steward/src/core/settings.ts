/**
 * Reader for the shared settings.json (~/.steward/agent/settings.json).
 *
 * A plain read of the shared settings file, no schema and no writer. Steward
 * only needs the default provider/model/scope to seed resolution when neither
 * `--model` nor agent.json specifies one.
 */

import { existsSync, readFileSync } from "node:fs";
import { getSettingsPath } from "../config.ts";

interface SharedSettings {
	defaultProvider?: string;
	defaultModel?: string;
	enabledModels?: string[];
}

// Parsed once per process and reused so the getters are cheap field reads
// rather than a fresh disk read each. The CLI reads this file once at startup.
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

export function getEnabledModels(): string[] | undefined {
	return readSettings().enabledModels;
}
