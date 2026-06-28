/**
 * Per-agent identity + settings.
 *
 * `AgentSettingsManager` owns the whole `agent.json` for one agent: its identity
 * (name/purpose/createdAt/deployedAt) AND a `settings` override block. The top-level
 * shared `~/.wolli/agent/settings.json` (the global tier, in settings-manager.ts) holds the
 * defaults; each agent's `settings` block deep-merges over those defaults, recomputed on load.
 * There is no per-child `settings.json` — runtime mutations write the override straight into
 * `agent.json`. The shared `Settings` types + the shared-defaults reader live in settings-manager.ts.
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
	getSoulPath,
	getUserMemoryPath,
	getWorkspaceDir,
} from "../config.ts";
import {
	clearSharedDefaultsCache,
	deepMergeSettings,
	loadSharedDefaults,
	type PluginSource,
	type Settings,
	sharedDefaultModelReference,
	type ThinkingLevelSetting,
} from "./settings-manager.ts";

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
		return this.merged.showHardwareCursor ?? process.env.WOLLI_HARDWARE_CURSOR === "1";
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false.
		if (this.merged.terminal?.clearOnShrink !== undefined) {
			return this.merged.terminal.clearOnShrink;
		}
		return process.env.WOLLI_CLEAR_ON_SHRINK === "1";
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

	getCompactionEnabled(): boolean {
		return this.merged.compaction?.enabled ?? true;
	}

	getCompactionReserveTokens(): number {
		return this.merged.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.merged.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
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

	setCompactionEnabled(enabled: boolean): void {
		this.updateSettings((settings) => {
			settings.compaction = { ...settings.compaction, enabled };
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
