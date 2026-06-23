/** Environment selection + barrel. Mirrors `core/service/service-manager.ts`. */

import chalk from "chalk";
import { ENV_SANDBOX } from "../../config.ts";
import type { ApprovalGate } from "../approval/types.ts";
import { createDockerEnvironment } from "./docker.ts";
import { createHostEnvironment } from "./host.ts";
import { createLocalOSEnvironment } from "./local-os.ts";
import { isSandboxSupported } from "./sandbox.ts";
import type { AgentEnvironments, Environment } from "./types.ts";

export { resetContainers } from "./container.ts";
export { createDockerEnvironment } from "./docker.ts";
export { createHostEnvironment } from "./host.ts";
export { createLocalOSEnvironment } from "./local-os.ts";
export { resetSandbox } from "./sandbox.ts";
export type { AgentEnvironments, Environment, FileStat } from "./types.ts";

/** Log a sandbox-init failure and fall back to host. The catch handler both backends share. */
function warnFallback(error: unknown): undefined {
	console.error(chalk.yellow(`Warning: sandbox init failed, falling back to host environment: ${error}`));
	return undefined;
}

/**
 * Wrap an environment so every command clears `gate` first. The gate runs inside `exec`, not as a
 * separate step a caller could skip; a refusal throws before the base env runs. The request's
 * `target` is `base.id` — also the key the store remembers rules under.
 */
export function createGatedEnvironment(base: Environment, gate: ApprovalGate): Environment {
	return {
		...base,
		exec: async (command, cwd, options) => {
			const decision = await gate({ target: base.id, command, cwd }, options.signal);
			if (!decision.allowed) {
				throw new Error(`Escalation to ${base.id} blocked: ${decision.reason}`);
			}
			return base.exec(command, cwd, options);
		},
	};
}

/**
 * Build the run targets per `STEWARD_SANDBOX`. With confinement (srt `local-os` by default, or
 * `docker` when explicitly opted in): a silent `sandbox` default + a gated `host` escape hatch.
 * Without it (unsupported / `=host` / backend init failure): a single silent `host` (nothing to
 * escalate from, so `gate` is unused).
 */
export async function createEnvironments(
	agentDir: string,
	opts: { gate: ApprovalGate; shellPath?: string },
): Promise<AgentEnvironments> {
	const override = process.env[ENV_SANDBOX]?.trim();
	// docker is explicit opt-in only; auto/unset falls through to srt-or-host.
	let sandbox: Environment | undefined;
	if (override === "docker") {
		sandbox = await createDockerEnvironment(agentDir, opts).catch(warnFallback);
	} else if (override === "local-os" || (override !== "host" && isSandboxSupported())) {
		sandbox = await createLocalOSEnvironment(agentDir, opts).catch(warnFallback);
	}

	const host = createHostEnvironment(agentDir, opts);
	if (!sandbox) {
		return { default: "host", targets: { host } };
	}
	const gatedHost = createGatedEnvironment(host, opts.gate);
	return { default: "sandbox", targets: { sandbox, host: gatedHost } };
}
