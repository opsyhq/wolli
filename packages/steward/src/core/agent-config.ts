/**
 * Per-agent identity config (`agent.json`).
 *
 * Net-new for steward (pi/coding-agent have no agent identity), but it reuses
 * coding-agent's conventions: typebox `*Schema` + `Compile(...)` validation (as
 * in model-registry.ts's `ModelsConfigSchema`/`validateModelsConfig`), plain
 * `readFileSync`/`writeFileSync` IO, and `create*`/`load*`/`save*`/`list*` verbs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	getAgentConfigPath,
	getAgentDir,
	getAgentsRoot,
	getMemoryPath,
	getSessionsDir,
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
	purpose: string;
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
		purpose,
		createdAt: new Date().toISOString(),
		...(model ? { model } : {}),
	};
	saveAgentConfig(name, config);

	// Empty curated memory files; populated via the memory tool (Phase 2).
	if (!existsSync(getMemoryPath(name))) writeFileSync(getMemoryPath(name), "", "utf-8");
	if (!existsSync(getUserMemoryPath(name))) writeFileSync(getUserMemoryPath(name), "", "utf-8");

	return config;
}
