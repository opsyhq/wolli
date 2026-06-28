/**
 * Construct a `DefaultPluginManager` bound to one agent's per-agent home.
 *
 * The agent's home (`~/.wolli/agents/<name>`) is the install root; the persisted
 * `plugins[]` lands in the agent's own `agent.json` settings override (never the shared
 * dir, and no per-child `settings.json`). `cwd` is the shell cwd so relative local
 * sources resolve from where the command was typed; they're normalized to
 * agent-relative before persisting, so they round-trip on launch.
 */

import { getAgentDir } from "../config.ts";
import { AgentSettingsManager } from "./agent-settings-manager.ts";
import { DefaultPluginManager } from "./plugin-manager.ts";

export interface AgentPluginManager {
	agentDir: string;
	settingsManager: AgentSettingsManager;
	pluginManager: DefaultPluginManager;
}

export function createAgentPluginManager(agentName: string): AgentPluginManager {
	const agentDir = getAgentDir(agentName);
	const cwd = process.cwd();
	// plugins[] persists into the agent's own agent.json settings override.
	const settingsManager = AgentSettingsManager.create(agentName);
	const pluginManager = new DefaultPluginManager({ cwd, agentDir, settingsManager });
	return { agentDir, settingsManager, pluginManager };
}
