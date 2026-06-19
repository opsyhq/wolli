/**
 * Construct a `DefaultPluginManager` bound to one agent's per-agent home.
 *
 * The agent's home (`~/.steward/agents/<name>`) is both the install root and the
 * settings location, so installs and the persisted `plugins[]` land in the per-agent
 * `settings.json`, never the shared dir. `cwd` is the shell cwd so relative local
 * sources resolve from where the command was typed; they're normalized to
 * agent-relative before persisting, so they round-trip on launch.
 */

import { getAgentDir } from "../config.ts";
import { DefaultPluginManager } from "./plugin-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

export interface AgentPluginManager {
	agentDir: string;
	settingsManager: SettingsManager;
	pluginManager: DefaultPluginManager;
}

export function createAgentPluginManager(agentName: string): AgentPluginManager {
	const agentDir = getAgentDir(agentName);
	const cwd = process.cwd();
	// SettingsManager's "global" scope path is `<agentDir>/settings.json`, so plugins[]
	// persists per-agent.
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const pluginManager = new DefaultPluginManager({ cwd, agentDir, settingsManager });
	return { agentDir, settingsManager, pluginManager };
}
