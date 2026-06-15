// Substrate-forced divergence: pi's source-info.ts imports `PathMetadata` from
// `package-manager.ts`, which steward does not vendor (it drags glob/minimatch/
// hosted-git-info). The type is inlined here — the only edge to package-manager.ts
// — so the rest of the file stays byte-identical to pi's. Both `createSourceInfo`
// and `createSyntheticSourceInfo` are kept verbatim (skills/loader/prompt-templates
// use the synthetic variant).

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

/** Inlined from pi's `package-manager.ts` (4 fields), the sole edge severed. */
export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
