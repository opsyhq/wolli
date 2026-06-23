/**
 * The srt isolation primitive, consumed only by `local.ts`. Hides
 * `@anthropic-ai/sandbox-runtime`'s process-global `SandboxManager` singleton
 * behind a thin function surface.
 *
 * Phase 2 is write-jail only: the read and network planes stay unrestricted.
 */

import {
	getDefaultWritePaths,
	type NetworkConfig,
	SandboxManager,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

/** Whether srt can confine on this platform (darwin/linux; false on Windows/WSL1). */
export function isSandboxSupported(): boolean {
	return SandboxManager.isSupportedPlatform();
}

export function createSandboxConfig(jailRoot: string, options?: { allowWrite?: string[] }): SandboxRuntimeConfig {
	// srt treats an absent `network.allowedDomains` as "no network restriction":
	// it gates restriction on `allowedDomains !== undefined` and only routes
	// through the proxy when set. The network plane is Phase 4, so we omit it. The
	// published `NetworkConfig` marks it required, hence the deniedDomains-only cast.
	const network = { deniedDomains: [] } as unknown as NetworkConfig;
	return {
		network,
		filesystem: {
			denyRead: [],
			allowWrite: [jailRoot, ...getDefaultWritePaths(), ...(options?.allowWrite ?? [])],
			denyWrite: [],
		},
	};
}

export interface Sandbox {
	wrap(command: string, binShell?: string): Promise<string>;
	cleanupAfterCommand(): void;
}

// The srt singleton owns proxy servers + OS profiles that must init exactly once.
// Memoize so repeated buildResources (every /reload) reuse it instead of leaking a
// second proxy. Cleared on init failure (retry next reload) and on reset.
let active: Promise<Sandbox> | undefined;

export function createSandbox(config: SandboxRuntimeConfig): Promise<Sandbox> {
	active ??= (async (): Promise<Sandbox> => {
		await SandboxManager.initialize(config);
		return {
			wrap: (command) => SandboxManager.wrapWithSandbox(command),
			cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
		};
	})().catch((err) => {
		active = undefined;
		throw err;
	});
	return active;
}

/** Best-effort teardown of the srt singleton + memo. Safe when never initialized. */
export async function resetSandbox(): Promise<void> {
	if (!active) return;
	active = undefined;
	try {
		await SandboxManager.reset();
	} catch {
		// Best-effort: reset failures must not block daemon shutdown.
	}
}
