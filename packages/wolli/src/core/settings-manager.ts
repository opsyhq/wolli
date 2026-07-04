/**
 * The global settings tier (`~/.wolli/agent/settings.json`): the shared `Settings` types, the
 * shared-defaults reader/writer, and the `SettingsManager` the daemon client exposes as
 * `Wolli.settings` — the exact parallel of `Wolli.auth`. Split back out of agent-settings-manager.ts
 * so the global tier has its own writer; the per-agent tier (`agent.json`) stays in that module.
 *
 * `SettingsManager` copies the method surface of coding-agent's `SettingsManager`
 * (packages/coding-agent/src/core/settings-manager.ts) — same names/signatures — with two deliberate
 * divergences: it is global-tier-only (no project scope, no storage/lock/write-queue machinery), and
 * `create()` takes no arguments (it always operates on the single `~/.wolli/agent/settings.json`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSettingsPath } from "../config.ts";

// =============================================================================
// Settings (the pruned live set)
// =============================================================================

export type ThinkingLevelSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Plugin source for npm/git/local plugins.
 * - String form: load all resources from the plugin
 * - Object form: filter which resources to load
 */
export type PluginSource =
	| string
	| {
			source: string;
			extensions?: string[];
			integrations?: string[];
			workflows?: string[];
			hooks?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface TerminalSettings {
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

/**
 * The shared defaults + per-agent override surface. Pruned to the set wolli/apps
 * actually read: model/thinking, resource lists (plugin-manager), tooling/telemetry
 * headers, and launcher UI.
 */
export interface Settings {
	// model / thinking
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevelSetting;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	compaction?: CompactionSettings; // auto-compaction toggle + token thresholds (global defaults)
	// resource lists (plugin-manager)
	plugins?: PluginSource[]; // Array of npm/git/local plugin sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	integrations?: string[]; // Array of local integration file paths or directories
	workflows?: string[]; // Array of local workflow file paths or directories
	hooks?: string[]; // Array of local hook file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	// tooling / telemetry headers
	npmCommand?: string[]; // argv-style command used for npm package lookup/install operations
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping
	// launcher UI (startup-ui)
	theme?: string;
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	terminal?: TerminalSettings;
}

/** Deep merge settings: overrides take precedence, nested objects merge recursively. */
export function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

// =============================================================================
// Shared defaults reader/writer (~/.wolli/agent/settings.json)
// =============================================================================
//
// Parsed once per process and reused so the merge is a cheap field read rather than a
// fresh disk read each time. `reload()` clears the cache so a `/reload` picks up edits.

let cachedSharedDefaults: Settings | undefined;

/** The shared defaults from `~/.wolli/agent/settings.json` (process-cached). */
export function loadSharedDefaults(): Settings {
	if (cachedSharedDefaults) return cachedSharedDefaults;
	const path = getSettingsPath();
	if (!existsSync(path)) {
		cachedSharedDefaults = {};
		return cachedSharedDefaults;
	}
	try {
		cachedSharedDefaults = JSON.parse(readFileSync(path, "utf-8")) as Settings;
	} catch {
		cachedSharedDefaults = {};
	}
	return cachedSharedDefaults;
}

/** Drop the process-cached shared defaults so the next read re-hits disk. */
export function clearSharedDefaultsCache(): void {
	cachedSharedDefaults = undefined;
}

/** The shared default model scope, read from `~/.wolli/agent/settings.json`. No callers today (the
 * `AgentSettingsManager.getEnabledModels()` method serves the runtime); kept as the global-tier reader. */
export function getEnabledModels(): string[] | undefined {
	return loadSharedDefaults().enabledModels;
}

/**
 * Read-modify-write the shared defaults file (`~/.wolli/agent/settings.json`), then drop the cache
 * so the next read re-hits disk. These shared writes are the global counterpart to the per-agent
 * `AgentSettingsManager` instance setters, which only ever write an agent's own `agent.json`.
 */
function updateSharedDefaults(patch: (settings: Settings) => void): void {
	const settings = structuredClone(loadSharedDefaults());
	patch(settings);
	const path = getSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	clearSharedDefaultsCache();
}

/** The shared default model as a `provider/modelId` reference (or bare model id). */
export function sharedDefaultModelReference(): string | undefined {
	const defaults = loadSharedDefaults();
	const model = defaults.defaultModel;
	if (!model) return undefined;
	return defaults.defaultProvider ? `${defaults.defaultProvider}/${model}` : model;
}

// =============================================================================
// SettingsManager (the global tier)
// =============================================================================

/**
 * The global settings tier, built once by `Wolli.settings`. Its method surface mirrors coding-agent's
 * `SettingsManager`; the bodies are thin over the process-cached `loadSharedDefaults()` /
 * `updateSharedDefaults()` (a simple read-modify-write), since there is no project scope to merge.
 */
export class SettingsManager {
	private constructor() {}

	/** Build the global settings manager over `~/.wolli/agent/settings.json` (parallels `AuthStorage.create()`). */
	static create(): SettingsManager {
		return new SettingsManager();
	}

	getDefaultProvider(): string | undefined {
		return loadSharedDefaults().defaultProvider;
	}

	/** The bare default model id (the provider is read separately via `getDefaultProvider()`). */
	getDefaultModel(): string | undefined {
		return loadSharedDefaults().defaultModel;
	}

	getDefaultThinkingLevel(): ThinkingLevelSetting | undefined {
		return loadSharedDefaults().defaultThinkingLevel;
	}

	/** Persist the default model as separate `defaultProvider` + bare `defaultModel`. */
	setDefaultModelAndProvider(provider: string, modelId: string): void {
		updateSharedDefaults((settings) => {
			settings.defaultProvider = provider;
			settings.defaultModel = modelId;
		});
	}

	setDefaultThinkingLevel(level: ThinkingLevelSetting): void {
		updateSharedDefaults((settings) => {
			settings.defaultThinkingLevel = level;
		});
	}
}
