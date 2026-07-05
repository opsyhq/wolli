import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { AgentSettingsManager } from "./agent-settings-manager.ts";
import { loadIntegrations } from "./integrations/loader.ts";
import type { IntegrationRunner } from "./integrations/runner.ts";
import type { Integration, LoadIntegrationsResult } from "./integrations/types.ts";
import { DefaultPluginManager, type PathMetadata, type ResolvedResource } from "./plugin-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";
import { loadTools } from "./tools/loader.ts";
import type { LoadToolsResult, Tool } from "./tools/types.ts";

const require = createRequire(import.meta.url);

export interface ResourceLoaderReloadOptions {
	/**
	 * Build the integration producer runner from the loaded integrations.
	 * Injected so the loader can construct the (unbound) runner without
	 * importing the account store. The caller (agent-runtime) owns the runner's
	 * bind/start/stop lifecycle.
	 */
	buildIntegrationRunner?: (input: { integrations: Integration[] }) => IntegrationRunner;
}

export interface ResourceLoader {
	getIntegrations(): LoadIntegrationsResult;
	getIntegrationRunner(): IntegrationRunner | undefined;
	getWorkflowPaths(): string[];
	getHookPaths(): string[];
	getProviderPaths(): string[];
	getTools(): LoadToolsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: AgentSettingsManager;
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: AgentSettingsManager;
	private pluginManager: DefaultPluginManager;
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private integrationsResult: LoadIntegrationsResult;
	/** The (unbound) integration producer runner built this reload; lifecycle is the caller's. */
	private integrationRunner?: IntegrationRunner;
	/** Resolved workflow file paths; the runtime loads them itself so it owns the per-generation runner swap. */
	private workflowPaths: string[];
	/** Resolved hook file paths; the runtime loads them itself so it owns the per-generation runner swap. */
	private hookPaths: string[];
	/** Resolved provider file paths; the runtime loads them itself so it owns model-registry registration. */
	private providerPaths: string[];
	/** Loaded tools/ definitions — inert (no runner), merged into session tooling by the runtime. */
	private toolsResult: LoadToolsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? AgentSettingsManager.create(basename(this.agentDir));
		this.pluginManager = new DefaultPluginManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.integrationsResult = { integrations: [], errors: [] };
		this.workflowPaths = [];
		this.hookPaths = [];
		this.providerPaths = [];
		this.toolsResult = { tools: [], errors: [] };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
	}

	getIntegrations(): LoadIntegrationsResult {
		return this.integrationsResult;
	}

	getIntegrationRunner(): IntegrationRunner | undefined {
		return this.integrationRunner;
	}

	getWorkflowPaths(): string[] {
		return this.workflowPaths;
	}

	getHookPaths(): string[] {
		return this.hookPaths;
	}

	getProviderPaths(): string[] {
		return this.providerPaths;
	}

	getTools(): LoadToolsResult {
		return this.toolsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		// New load generation: evict the previous generation's modules under the agent home so
		// the resource loaders' jiti (moduleCache: true, backed by the process-global CommonJS
		// cache) re-evaluates edited files. Loaders realpath before importing and jiti resolves
		// nested imports through realpath, so the canonicalized prefix matches every key a
		// generation wrote. Keys under node_modules stay cached: plugin dependency trees are
		// immutable between installs, and re-evaluating their module graphs (grammy, discord.js)
		// on every reload is the dominant reload cost.
		const canonicalRoot = canonicalizePath(this.cwd) + sep;
		for (const key of Object.keys(require.cache)) {
			if (key.startsWith(canonicalRoot) && !key.includes(`${sep}node_modules${sep}`)) {
				delete require.cache[key];
			}
		}

		await this.settingsManager.reload();
		const resolvedPaths = await this.pluginManager.resolve();
		const metadataByPath = new Map<string, PathMetadata>();

		// Helper to extract enabled paths and store metadata
		const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
			getEnabledResources(resources).map((r) => r.path);
		const enabledIntegrations = getEnabledPaths(resolvedPaths.integrations);
		const enabledWorkflows = getEnabledPaths(resolvedPaths.workflows);
		const enabledHooks = getEnabledPaths(resolvedPaths.hooks);
		const enabledTools = getEnabledPaths(resolvedPaths.tools);
		const enabledProviders = getEnabledPaths(resolvedPaths.providers);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const enabledSkills = enabledSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath));

		// Integration arm — BEFORE the tools arm. Load the integrations resolved in
		// place (so a dual-half package's integration resolves from the same install as
		// its paired workflow), overwrite their synthetic source info with the real
		// resolve() metadata, then build the (unbound) producer runner. The caller owns
		// its bind/start/stop lifecycle. Integrations evaluate before the runtime's
		// workflow load, so descriptors are stamped before workflow triggers are indexed.
		const integrationsResult = await loadIntegrations(enabledIntegrations, this.cwd);
		this.applyIntegrationSourceInfo(integrationsResult.integrations, metadataByPath);
		this.integrationsResult = integrationsResult;
		this.integrationRunner = options?.buildIntegrationRunner?.({
			integrations: integrationsResult.integrations,
		});

		// Tools arm — after the integration arm, so a tool importing its integration file
		// resolves (through the shared module cache) to the stamped definition. Tools are
		// inert defineTool definitions: no runner, no runtime object — session tooling
		// assembly stays workflow-independent by construction.
		const toolsResult = await loadTools(enabledTools, this.cwd);
		this.applyToolSourceInfo(toolsResult.tools, metadataByPath);
		this.toolsResult = toolsResult;

		// Workflows arm: resolution only. The runtime runs loadWorkflows over these paths
		// itself so it can stamp the load generation and swap the WorkflowRunner.
		this.workflowPaths = enabledWorkflows;

		// Hooks arm: resolution only. The runtime runs loadHooks over these paths itself
		// so it can stamp the load generation and swap the hook runner.
		this.hookPaths = enabledHooks;

		// Providers arm: resolution only. The runtime runs loadProviders over these paths
		// itself so it owns model-registry registration.
		this.providerPaths = enabledProviders;

		const skillPaths = this.mergePaths(this.noSkills ? [] : enabledSkills, this.additionalSkillPaths);

		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		const promptPaths = this.mergePaths(
			this.noPromptTemplates ? [] : enabledPrompts,
			this.additionalPromptTemplatePaths,
		);

		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		const themePaths = this.mergePaths(this.noThemes ? [] : enabledThemes, this.additionalThemePaths);

		this.updateThemesFromPaths(themePaths, metadataByPath);
		for (const p of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
					}),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const baseSystemPrompt = resolvePromptInput(
			this.systemPromptSource ?? this.discoverSystemPromptFile(),
			"system prompt",
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		const appendSources =
			this.appendSystemPromptSource ??
			(this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	private mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
			return resource.path;
		}
		try {
			const stats = statSync(resource.path);
			if (!stats.isDirectory()) {
				return resource.path;
			}
		} catch {
			return resource.path;
		}
		const skillFile = join(resource.path, "SKILL.md");
		if (existsSync(skillFile)) {
			if (!metadataByPath.has(skillFile)) {
				metadataByPath.set(skillFile, resource.metadata);
			}
			return skillFile;
		}
		return resource.path;
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, undefined, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, undefined, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, undefined, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	/**
	 * Overwrite each integration's synthetic `local` source info (set at load time by
	 * `loadIntegrations`) with the real `resolve()` metadata, so a package-resolved
	 * integration carries `origin: "package"` + the real source spec rather than a
	 * synthetic local.
	 */
	private applyIntegrationSourceInfo(integrations: Integration[], metadataByPath: Map<string, PathMetadata>): void {
		for (const integration of integrations) {
			integration.sourceInfo =
				this.findSourceInfoForPath(integration.path, undefined, metadataByPath) ??
				this.findSourceInfoForPath(integration.resolvedPath, undefined, metadataByPath) ??
				integration.sourceInfo;
		}
	}

	/** Mirror of `applyIntegrationSourceInfo` for tools/ definitions. */
	private applyToolSourceInfo(tools: Tool[], metadataByPath: Map<string, PathMetadata>): void {
		for (const tool of tools) {
			tool.sourceInfo =
				this.findSourceInfoForPath(tool.path, undefined, metadataByPath) ??
				this.findSourceInfoForPath(tool.resolvedPath, undefined, metadataByPath) ??
				tool.sourceInfo;
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [join(this.agentDir, "skills"), join(this.agentDir, "prompts"), join(this.agentDir, "themes")];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}
}
