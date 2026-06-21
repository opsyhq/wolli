/**
 * Per-agent identity config (`agent.json`).
 *
 * Net-new for steward. Uses typebox `*Schema` + `Compile(...)` validation, plain
 * `readFileSync`/`writeFileSync` IO, and `create*`/`load*`/`save*`/`list*` verbs.
 */

import { spawnSync } from "node:child_process";
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

export const AGENT_SCHEMA_VERSION = 1;

export const AgentConfigSchema = Type.Object({
	schemaVersion: Type.Number(),
	name: Type.String(),
	purpose: Type.String(),
	createdAt: Type.String(),
	model: Type.Optional(Type.String()),
	/** Agent-tier default thinking level; reloaded on each new session, restored per session on resume. */
	thinkingLevel: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
	/** Scoped-model patterns (same format as the `--models` CLI flag) — the agent-tier shortlist. */
	enabledModels: Type.Optional(Type.Array(Type.String())),
	/**
	 * The single human-held latch. `null` (or absent) means the agent is still in
	 * its birth phase — it maintains its own files but may not act unattended. An
	 * ISO timestamp grants it that right. Optional/nullable so agent.json written
	 * before this field still validates (treated as not deployed).
	 */
	deployedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type AgentConfig = Static<typeof AgentConfigSchema>;

const validateAgentConfig = Compile(AgentConfigSchema);

/** Agent names map to a single on-disk directory, so keep them filesystem-safe. */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_PATTERN.test(name);
}

export function agentExists(name: string): boolean {
	return existsSync(getAgentConfigPath(name));
}

export function loadAgentConfig(name: string): AgentConfig {
	const path = getAgentConfigPath(name);
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!validateAgentConfig.Check(parsed)) {
		const detail = validateAgentConfig
			.Errors(parsed)
			.map((error) => `${error.instancePath || "root"}: ${error.message}`)
			.join("; ");
		throw new Error(`Invalid agent config at ${path}${detail ? `: ${detail}` : ""}`);
	}
	return parsed;
}

export function saveAgentConfig(name: string, config: AgentConfig): void {
	mkdirSync(getAgentDir(name), { recursive: true });
	writeFileSync(getAgentConfigPath(name), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** All agents under the agents root, sorted by name. Skips non-agent dirs. */
export function listAgents(): AgentConfig[] {
	const root = getAgentsRoot();
	if (!existsSync(root)) return [];

	const configs: AgentConfig[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !agentExists(entry.name)) continue;
		try {
			configs.push(loadAgentConfig(entry.name));
		} catch {
			// Skip directories that aren't valid agents.
		}
	}
	configs.sort((a, b) => a.name.localeCompare(b.name));
	return configs;
}

export interface CreateAgentOptions {
	name: string;
	/** Optional at birth — left empty until the agent authors its own purpose via the deploy tool. Defaults to "". */
	purpose?: string;
	model?: string;
}

/** Create an agent's home tree (`agent.json`, empty memory files, sessions/, workspace/). */
export function createAgent(options: CreateAgentOptions): AgentConfig {
	const { name, purpose, model } = options;
	if (!isValidAgentName(name)) {
		throw new Error(
			`Invalid agent name "${name}". Use lowercase letters, digits, and hyphens (must start with a letter or digit).`,
		);
	}
	if (agentExists(name)) {
		throw new Error(`Agent "${name}" already exists.`);
	}

	mkdirSync(getAgentDir(name), { recursive: true });
	mkdirSync(getSessionsDir(name), { recursive: true });
	mkdirSync(getWorkspaceDir(name), { recursive: true });

	const config: AgentConfig = {
		schemaVersion: AGENT_SCHEMA_VERSION,
		name,
		purpose: purpose ?? "",
		createdAt: new Date().toISOString(),
		...(model ? { model } : {}),
		deployedAt: null,
	};
	saveAgentConfig(name, config);

	// Empty curated files; the agent populates them via the self_update tool.
	if (!existsSync(getSoulPath(name))) writeFileSync(getSoulPath(name), "", "utf-8");
	if (!existsSync(getMemoryPath(name))) writeFileSync(getMemoryPath(name), "", "utf-8");
	if (!existsSync(getUserMemoryPath(name))) writeFileSync(getUserMemoryPath(name), "", "utf-8");

	return config;
}

/** Whether the agent has been deployed (granted the right to act unattended). */
export function isDeployed(config: AgentConfig): boolean {
	return Boolean(config.deployedAt);
}

/** Set deployedAt once (idempotent: returns existing config if already set). */
export function deployAgent(name: string): AgentConfig {
	const config = loadAgentConfig(name);
	if (config.deployedAt) return config;
	const updated = { ...config, deployedAt: new Date().toISOString() };
	saveAgentConfig(name, updated);
	return updated;
}

/** Set the agent's purpose (authored by the agent via the deploy tool) and persist. */
export function setAgentPurpose(name: string, purpose: string): AgentConfig {
	const config = loadAgentConfig(name);
	const updated = { ...config, purpose };
	saveAgentConfig(name, updated);
	return updated;
}

/**
 * Delete an agent's entire home dir, trying the `trash` CLI first, then falling
 * back to a permanent recursive remove (`rmSync(..., recursive)`). Operates solely
 * on `getAgentDir(name)` — never the shared agent credential dir.
 */
export function deleteAgent(name: string): { ok: boolean; method: "trash" | "unlink"; error?: string } {
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
