/**
 * Container backend: every file/shell op runs inside the container via `docker exec`. The agent home
 * is bind-mounted at its own path and nothing else of the host is, so absolute paths resolve against
 * the container's own FS, never the host. The container boundary is the jail — no host-side write-jail.
 *
 * Control state in the mounted home is not yet write-protected here (srt's denyWrite has no analogue);
 * that lands when the home moves to an isolated volume.
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
