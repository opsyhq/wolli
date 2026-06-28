/**
 * Read-only view of the footer data the interactive client computes (git branch, extension
 * statuses, provider count) and hands to extension footer factories. The runtime provider that
 * watches git and produces this data is client-only and lives in apps/cli; this is the standalone
 * contract the extension surface (core/extensions/types.ts) and the moved provider share.
 */
export interface ReadonlyFooterDataProvider {
	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null;
	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string>;
	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number;
	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void;
}
