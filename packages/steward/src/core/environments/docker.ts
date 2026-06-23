/**
 * Container backend: every file/shell op runs inside the container via `docker exec`.
 *
 * The agent home is bind-mounted into the container at its own path, and nothing else of the host
 * is — so absolute paths resolve against the container's own FS (its home + the image), never the
 * host outside it. There is no host-side write-jail here: the container boundary IS the jail, and
 * the file methods physically cannot reach the host. The agent's writes still land in its home
 * (the mount), so the daemon's host-side resource loader sees them on reload.
 *
 * Control state (approvals.json / sessions/ / agent.json) lives in that mounted home and is NOT yet
 * write-protected on this backend — that lands when the home moves from a bind mount to an isolated
 * volume (it's absent from a volume, so no carve-out is needed). srt's denyWrite plane has no
 * analogue here, so deferring it is the honest state until then.
 */

import { resolveToCwd } from "../tools/path-utils.ts";
import { createContainerConfig, startContainer } from "./container.ts";
import type { Environment } from "./types.ts";

export async function createDockerEnvironment(
	cwd: string,
	options?: { shellPath?: string; image?: string },
): Promise<Environment> {
	const container = await startContainer(createContainerConfig(cwd, options));
	return {
		id: "docker",
		cwd,
		resolvePath: (p) => resolveToCwd(p, cwd),
		exec: container.exec,
		readFile: container.readFile,
		writeFile: container.writeFile,
		mkdir: container.mkdir,
		access: container.access,
		exists: container.exists,
		stat: container.stat,
		readdir: container.readdir,
		detectImageMimeType: container.detectImageMimeType,
	};
}
