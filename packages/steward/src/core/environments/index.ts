/** Environment selection + barrel. Mirrors `core/service/service-manager.ts`. */

import chalk from "chalk";
import { ENV_SANDBOX } from "../../config.ts";
import { createHostEnvironment } from "./host.ts";
import { createLocalOSEnvironment } from "./local-os.ts";
import { isSandboxSupported } from "./sandbox.ts";
import type { Environment } from "./types.ts";

export { createHostEnvironment } from "./host.ts";
export { createLocalOSEnvironment } from "./local-os.ts";
export { resetSandbox } from "./sandbox.ts";
export type { Environment, FileStat } from "./types.ts";

/**
 * Create the file/shell backend for `agentDir`, honoring the `STEWARD_SANDBOX`
 * override (host|local-os|auto). Confined `local-os` degrades to the unconfined
 * host if srt init fails.
 */
export async function createEnvironment(
	agentDir: string,
	options?: { shellPath?: string; allowWrite?: string[] },
): Promise<Environment> {
	const override = process.env[ENV_SANDBOX]?.trim();
	const useLocalOS = override === "local-os" || (override !== "host" && isSandboxSupported());
	if (!useLocalOS) {
		return createHostEnvironment(agentDir, options);
	}
	try {
		return await createLocalOSEnvironment(agentDir, options);
	} catch (error) {
		console.error(chalk.yellow(`Warning: sandbox init failed, falling back to host environment: ${error}`));
		return createHostEnvironment(agentDir, options);
	}
}
