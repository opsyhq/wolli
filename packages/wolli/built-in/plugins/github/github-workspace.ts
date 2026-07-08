/**
 * Host-side git plumbing for the review checkout.
 *
 * Unlike `github-api.ts` this module is NOT host-free: it shells out to the `git` CLI and writes
 * under the agent home dir. Its job is to put a pull request's full source tree on disk where the
 * review agent's native `read`/`grep`/`bash` tools can see it, so the agent reviews real code
 * instead of a diff pasted into its prompt.
 *
 * Two safety properties this file is responsible for:
 *  - The App installation token is passed to `git` only on the argv of a single `fetch` (in the
 *    daemon process), never written to disk and never stored as a remote — so it cannot be
 *    recovered from `.git/config` by the agent.
 *  - No remote is configured on the checkout, so there is no push target: the working copy is
 *    read-only as far as the agent is concerned. (A bash-capable agent could still add a remote
 *    and push with the host's ambient credentials; a hard guarantee needs a network-jailed
 *    sandbox. This removes the footgun, not the determined path.)
 *
 * The checkout lives under `workspace/` (a subdir of the agent home) because that is the one
 * location visible to the agent's tools across every backend: host, the srt write-jail (rooted
 * at the agent home), and the docker bind-mount (the agent home mounted at the identical path).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Absolute and cwd-relative paths of a PR's review checkout, under the agent's `workspace/`. */
export function reviewPaths(
	agentCwd: string,
	repo: string,
	pullRequestNumber: number,
): { absDir: string; relDir: string } {
	const slug = `${repo.replace("/", "__")}__${pullRequestNumber}`;
	const relDir = join("workspace", "reviews", slug);
	return { absDir: join(agentCwd, relDir), relDir };
}

/**
 * Run one git command as an argv array (no shell, so nothing in the args is interpolated). The
 * error carries only the subcommand (`args[0]`) and stderr — never the full args — so a token
 * passed in a fetch URL cannot leak into a thrown/logged error.
 */
function runGit(args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim().slice(0, 500)}`));
		});
	});
}

/**
 * Check out `headSha` (detached, depth 1) at `destDir`, with `baseSha` fetched alongside it so the
 * agent can `git diff <base> <head>`. Initializes the dir on first use and refreshes it in place on
 * later turns. The tokenized URL is passed only to the `fetch` and is never stored as a remote.
 */
export async function checkout(opts: {
	destDir: string;
	repo: string;
	token: string;
	headSha: string;
	baseSha: string;
}): Promise<void> {
	const { destDir, repo, token, headSha, baseSha } = opts;
	if (!headSha) throw new Error("checkout: missing head sha");
	const tokenUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
	const shas = baseSha && baseSha !== headSha ? [headSha, baseSha] : [headSha];

	if (!existsSync(join(destDir, ".git"))) {
		await mkdir(destDir, { recursive: true });
		await runGit(["init", "-q"], destDir);
	}
	await runGit(["fetch", "--depth", "1", tokenUrl, ...shas], destDir);
	await runGit(["checkout", "-q", "--detach", headSha], destDir);
	await runGit(["reset", "--hard", "-q", headSha], destDir);
	await runGit(["clean", "-fdxq"], destDir);
}
