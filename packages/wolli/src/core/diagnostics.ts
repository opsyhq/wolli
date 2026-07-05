export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}

/** Loaded-resource counts plus any diagnostics, surfaced at startup and after `/reload`. */
export interface ResourceSummary {
	extensions: number;
	tools: number;
	/** Optional so the daemon client's cached default (which predates the providers folder) stays valid. */
	providers?: number;
	skills: number;
	prompts: number;
	commands: number;
	diagnostics: ResourceDiagnostic[];
}
