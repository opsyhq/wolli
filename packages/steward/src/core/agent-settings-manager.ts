/**
 * Per-agent identity + settings, unified.
 *
 * `AgentSettingsManager` owns the whole `agent.json` for one agent: its identity
 * (name/purpose/createdAt/deployedAt) AND a `settings` override block. The top-level
 * shared `~/.steward/agent/settings.json` holds the defaults; each agent's `settings`
 * block deep-merges over those defaults, recomputed on load. There is no per-child
 * `settings.json` — runtime mutations write the override straight into `agent.json`.
 *
 * This folds together what used to be three modules (agent-config.ts, settings-manager.ts,
 * settings.ts): identity IO + the typed settings surface + the shared-defaults reader.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	getAgentConfigPath,
	getAgentDir,
	getAgentsRoot,
	getMemoryPath,
	getSessionsDir,
	getSettingsPath,
	getSoulPath,
	getUserMemoryPath,
	getWorkspaceDir,
} from "../config.ts";

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
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface TerminalSettings {
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

/**
 * The shared defaults + per-agent override surface. Pruned to the set steward/apps
 * actually read: model/thinking, resource lists (plugin-manager), tooling/telemetry
 * headers, and launcher UI.
 */
export interface Settings {
	// model / thinking
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevelSetting;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	// resource lists (plugin-manager)
	plugins?: PluginSource[]; // Array of npm/git/local plugin sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	integrations?: string[]; // Array of local integration file paths or directories
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
// Shared defaults reader (~/.steward/agent/settings.json)
// =============================================================================
//
// Parsed once per process and reused so the merge is a cheap field read rather than a
// fresh disk read each time. `reload()` clears the cache so a `/reload` picks up edits.

let cachedSharedDefaults: Settings | undefined;

/** The shared defaults from `~/.steward/agent/settings.json` (process-cached). */
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

/** The shared default provider, read from `~/.steward/agent/settings.json`. */
export function getDefaultProvider(): string | undefined {
	return loadSharedDefaults().defaultProvider;
}

/** The shared default model id, read from `~/.steward/agent/settings.json`. */
export function getDefaultModel(): string | undefined {
	return loadSharedDefaults().defaultModel;
}

/** The shared default model scope, read from `~/.steward/agent/settings.json`. */
export function getEnabledModels(): string[] | undefined {
	return loadSharedDefaults().enabledModels;
}

/** The shared default model as a `provider/modelId` reference (or bare model id). */
function sharedDefaultModelReference(): string | undefined {
	const model = getDefaultModel();
	if (!model) return undefined;
	const provider = getDefaultProvider();
	return provider ? `${provider}/${model}` : model;
}

// =============================================================================
// agent.json schema
// =============================================================================

export const AGENT_SCHEMA_VERSION = 2;

export const AgentConfigSchema = Type.Object({
	schemaVersion: Type.Number(),
	name: Type.String(),
	purpose: Type.String(),
	createdAt: Type.String(),
	/** The fixed port the agent's daemon binds, allocated at creation (required; missing → fails loud). */
	port: Type.Number(),
	/** The bearer token for the daemon's `/events` + `/control`, minted at creation. */
	token: Type.String(),
	/**
	 * The single human-held latch. `null` (or absent) means the agent is still in
	 * its birth phase — it maintains its own files but may not act unattended. An
	 * ISO timestamp grants it that right. Optional/nullable so agent.json written
	 * before this field still validates (treated as not deployed).
	 */
	deployedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	/**
	 * Per-agent settings override, deep-merged over the shared defaults. Loosely typed
	 * on disk (any keys); narrowed to `Partial<Settings>` in `AgentConfig` below.
	 */
	settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type RawAgentConfig = Static<typeof AgentConfigSchema>;
export type AgentConfig = Omit<RawAgentConfig, "settings"> & { settings?: Partial<Settings> };

const validateAgentConfig = Compile(AgentConfigSchema);

// =============================================================================
// Free helpers
// =============================================================================

/** Agent names map to a single on-disk directory, so keep them filesystem-safe. */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_PATTERN.test(name);
}

/** Whether the agent has been deployed (granted the right to act unattended). */
export function isDeployed(config: AgentConfig): boolean {
	return Boolean(config.deployedAt);
}

export interface CreateAgentOptions {
	name: string;
	/** Optional at birth — left empty until the agent authors its own purpose via the deploy tool. Defaults to "". */
	purpose?: string;
	/** Optional `provider/modelId` reference; folded into `settings.defaultModel`. */
	model?: string;
}

// =============================================================================
// AgentSettingsManager
// =============================================================================

export class AgentSettingsManager {
	readonly name: string;
	private _config: AgentConfig;
	private merged: Settings;
	/**
	 * In-memory project-trust flag. Gates project-local extension/SYSTEM.md loading in
	 * the resource loader; independent of settings storage (the agent home is always
	 * trusted, so this defaults to true).
	 */
	private projectTrusted = true;

	private constructor(name: string, config: AgentConfig) {
		this.name = name;
		this._config = config;
		this.merged = deepMergeSettings(loadSharedDefaults(), config.settings ?? {});
	}

	// --- statics -------------------------------------------------------------

	/** Construct a manager for an existing agent (throws if its `agent.json` is missing/invalid). */
	static create(name: string): AgentSettingsManager {
		return new AgentSettingsManager(name, AgentSettingsManager.loadConfig(name));
	}

	/** Construct a manager for `name` if it exists on disk, else `undefined`. */
	static get(name: string): AgentSettingsManager | undefined {
		if (!existsSync(getAgentConfigPath(name))) return undefined;
		try {
			return AgentSettingsManager.create(name);
		} catch {
			return undefined;
		}
	}

	/** All agents under the agents root, sorted by name. Skips non-agent/invalid dirs. */
	static list(): AgentSettingsManager[] {
		const root = getAgentsRoot();
		if (!existsSync(root)) return [];

		const managers: AgentSettingsManager[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manager = AgentSettingsManager.get(entry.name);
			if (manager) managers.push(manager);
		}
		managers.sort((a, b) => a.name.localeCompare(b.name));
		return managers;
	}

	/** Create an agent's home tree (`agent.json`, empty memory files, sessions/, workspace/). */
	static createAgent(options: CreateAgentOptions): AgentSettingsManager {
		const { name, purpose, model } = options;
		if (!isValidAgentName(name)) {
			throw new Error(
				`Invalid agent name "${name}". Use lowercase letters, digits, and hyphens (must start with a letter or digit).`,
			);
		}
		if (existsSync(getAgentConfigPath(name))) {
			throw new Error(`Agent "${name}" already exists.`);
		}

		mkdirSync(getAgentDir(name), { recursive: true });
		mkdirSync(getSessionsDir(name), { recursive: true });
		mkdirSync(getWorkspaceDir(name), { recursive: true });

		// A random high port, skipping any already claimed by another agent. Not a live bind: the daemon
		// fails loud on EADDRINUSE if it is taken when it actually binds.
		const usedPorts = new Set(AgentSettingsManager.list().map((store) => store.config.port));
		let port = 0;
		for (let i = 0; i < 1000 && !port; i++) {
			const candidate = 20000 + Math.floor(Math.random() * 40001);
			if (!usedPorts.has(candidate)) port = candidate;
		}
		if (!port) throw new Error("Could not allocate a free port for the agent.");

		const config: AgentConfig = {
			schemaVersion: AGENT_SCHEMA_VERSION,
			name,
			purpose: purpose ?? "",
			createdAt: new Date().toISOString(),
			deployedAt: null,
			port,
			token: randomBytes(32).toString("hex"),
			...(model ? { settings: { defaultModel: model } } : {}),
		};
		AgentSettingsManager.saveConfig(name, config);

		// Empty curated files; the agent populates them via the self_update tool.
		if (!existsSync(getSoulPath(name))) writeFileSync(getSoulPath(name), "", "utf-8");
		if (!existsSync(getMemoryPath(name))) writeFileSync(getMemoryPath(name), "", "utf-8");
		if (!existsSync(getUserMemoryPath(name))) writeFileSync(getUserMemoryPath(name), "", "utf-8");

		return new AgentSettingsManager(name, config);
	}

	/**
	 * Delete an agent's entire home dir, trying the `trash` CLI first, then falling
	 * back to a permanent recursive remove. Operates solely on `getAgentDir(name)` —
	 * never the shared agent credential dir.
	 */
	static delete(name: string): { ok: boolean; method: "trash" | "unlink"; error?: string } {
		const dir = getAgentDir(name);

		// Try `trash` first (if installed)
		const trashArgs = dir.startsWith("-") ? ["--", dir] : [dir];
		const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

		const getTrashErrorHint = (): string | null => {
			const parts: string[] = [];
			if (trashResult.error) {
				parts.push(trashResult.error.message);
			}
			const stderr = trashResult.stderr?.trim();
			if (stderr) {
				parts.push(stderr.split("\n")[0] ?? stderr);
			}
			if (parts.length === 0) return null;
			return `trash: ${parts.join(" · ").slice(0, 200)}`;
		};

		// If trash reports success, or the dir is gone afterwards, treat it as successful
		if (trashResult.status === 0 || !existsSync(dir)) {
			return { ok: true, method: "trash" };
		}

		// Fallback to permanent deletion
		try {
			rmSync(dir, { recursive: true, force: true });
			return { ok: true, method: "unlink" };
		} catch (err) {
			const unlinkError = err instanceof Error ? err.message : String(err);
			const trashErrorHint = getTrashErrorHint();
			const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
			return { ok: false, method: "unlink", error };
		}
	}

	private static loadConfig(name: string): AgentConfig {
		const path = getAgentConfigPath(name);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!validateAgentConfig.Check(parsed)) {
			const detail = validateAgentConfig
				.Errors(parsed)
				.map((error) => `${error.instancePath || "root"}: ${error.message}`)
				.join("; ");
			throw new Error(`Invalid agent config at ${path}${detail ? `: ${detail}` : ""}`);
		}
		return parsed as AgentConfig;
	}

	private static saveConfig(name: string, config: AgentConfig): void {
		mkdirSync(getAgentDir(name), { recursive: true });
		writeFileSync(getAgentConfigPath(name), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	}

	// --- identity ------------------------------------------------------------

	get config(): AgentConfig {
		return this._config;
	}

	getAgentDeployed(): boolean {
		return Boolean(this._config.deployedAt);
	}

	/** Stamp deployedAt once (idempotent: a second call leaves the timestamp unchanged). */
	setAgentDeployed(): AgentConfig {
		this.update((config) => (config.deployedAt ? config : { ...config, deployedAt: new Date().toISOString() }));
		return this._config;
	}

	/** Set the agent's purpose (authored by the agent via the deploy tool) and persist. */
	setAgentPurpose(purpose: string): AgentConfig {
		this.update((config) => ({ ...config, purpose }));
		return this._config;
	}

	// --- merged getters (the live set) --------------------------------------

	getGlobalSettings(): Settings {
		return structuredClone(this.merged);
	}

	getPlugins(): PluginSource[] {
		return [...(this.merged.plugins ?? [])];
	}

	getNpmCommand(): string[] | undefined {
		return this.merged.npmCommand ? [...this.merged.npmCommand] : undefined;
	}

	getEnableInstallTelemetry(): boolean {
		return this.merged.enableInstallTelemetry ?? true;
	}

	getTheme(): string | undefined {
		return this.merged.theme;
	}

	getShowHardwareCursor(): boolean {
		return this.merged.showHardwareCursor ?? process.env.STEWARD_HARDWARE_CURSOR === "1";
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false.
		if (this.merged.terminal?.clearOnShrink !== undefined) {
			return this.merged.terminal.clearOnShrink;
		}
		return process.env.STEWARD_CLEAR_ON_SHRINK === "1";
	}

	getDefaultProvider(): string | undefined {
		return this.merged.defaultProvider;
	}

	/**
	 * The agent's effective model as a `provider/modelId` reference. An agent override
	 * (stored combined) wins; otherwise the shared default (provider + model combined).
	 */
	getDefaultModel(): string | undefined {
		const override = this._config.settings?.defaultModel;
		if (override) return override;
		return sharedDefaultModelReference();
	}

	getDefaultThinkingLevel(): ThinkingLevelSetting | undefined {
		return this.merged.defaultThinkingLevel;
	}

	getEnabledModels(): string[] | undefined {
		return this.merged.enabledModels;
	}

	// --- setters (write the override into agent.json.settings) ---------------

	setPlugins(plugins: PluginSource[]): void {
		this.updateSettings((settings) => {
			settings.plugins = plugins;
		});
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.updateSettings((settings) => {
			if (patterns) {
				settings.enabledModels = patterns;
			} else {
				delete settings.enabledModels;
			}
		});
	}

	setClearOnShrink(enabled: boolean): void {
		this.updateSettings((settings) => {
			settings.terminal = { ...settings.terminal, clearOnShrink: enabled };
		});
	}

	setDefaultThinkingLevel(level: ThinkingLevelSetting): void {
		this.updateSettings((settings) => {
			settings.defaultThinkingLevel = level;
		});
	}

	/** Persist a model choice as the combined `provider/modelId` reference. */
	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.updateSettings((settings) => {
			settings.defaultModel = `${provider}/${modelId}`;
		});
	}

	// --- project trust (in-memory, no file) ---------------------------------

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		this.projectTrusted = trusted;
	}

	// --- reload + persistence ------------------------------------------------

	/** Re-read shared defaults + `agent.json` from disk and recompute the merged view. */
	reload(): void {
		clearSharedDefaultsCache();
		this._config = AgentSettingsManager.loadConfig(this.name);
		this.merged = deepMergeSettings(loadSharedDefaults(), this._config.settings ?? {});
	}

	/** Fresh read-modify-write of `agent.json`, then refresh the merged view. */
	private update(mutator: (config: AgentConfig) => AgentConfig): void {
		const fresh = AgentSettingsManager.loadConfig(this.name);
		const updated = mutator(fresh);
		AgentSettingsManager.saveConfig(this.name, updated);
		this._config = updated;
		this.merged = deepMergeSettings(loadSharedDefaults(), updated.settings ?? {});
	}

	private updateSettings(patch: (settings: Partial<Settings>) => void): void {
		this.update((config) => {
			const settings: Partial<Settings> = { ...(config.settings ?? {}) };
			patch(settings);
			return { ...config, settings };
		});
	}
}
