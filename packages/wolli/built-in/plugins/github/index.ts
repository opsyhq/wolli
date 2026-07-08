/**
 * GitHub integration — the transport half (self-contained package).
 *
 * wolli has no inbound webhook surface, so this integration is a **polling** producer in the
 * same shape as the telegram long-poll / scheduler tick: `run()` wakes on a timer, pulls each
 * watched repo's cheap repo-level "since" endpoints with a conditional (ETag) request, and
 * emits one generic event per new item. It holds the GitHub App credentials and mints
 * per-installation tokens; it never touches sessions. The routing workflows (`github-chat.ts`,
 * declared under `wolli.workflows`) map those events onto sessions.
 *
 * Auth is a GitHub App: a short-lived RS256 JWT is exchanged per installation for a ~1h token.
 * No webhook secret, no public URL. The standard App-auth mechanics, the REST wrapper, the raw
 * normalizers, and the pure cursor logic all live in `./github-api.ts` (host-free, so they unit
 * test on their own); this file is the `defineIntegration(...)` transport that wires them to
 * `ctx.account` / `ctx.store` / `ctx.emit`.
 *
 * ## Install + configure
 *
 *   wolli <agent> plugins install ./built-in/plugins/github
 *   # then paste the App id + private key, enter the repos, pick the triggers.
 *
 * See README.md for creating the App and the end-to-end setup.
 *
 * ## Known v1 limitations
 *  - Polling, not webhooks: latency is up to one poll interval, and the `issues` / `pull_request`
 *    streams carry a BEST-EFFORT `action` (opened/edited/closed/synchronize) synthesized from
 *    state + timestamps — there is no real webhook `action` to read.
 *  - The excluded tiers (`pull_request_review`, `push`) have no clean repo-level "since" cursor.
 */

import { defineIntegration, type IntegrationOnboardContext, type KeyValueStore } from "wolli";
import { Type } from "typebox";
import {
	type AppCredentials,
	createAppJwt,
	createInstallationToken,
	DEFAULT_POLL_INTERVAL_MS,
	githubRequest,
	normalizeIssue,
	normalizeIssueComment,
	normalizePullRequest,
	normalizeReviewComment,
	parseJson,
	parseRepo,
	type RawJson,
	readHeadSha,
	resolveRepoInstallationId,
	selectPullRequests,
	selectSinceItems,
} from "./github-api.ts";
import { checkout } from "./github-workspace.ts";

/** The four cheap repo-level streams the transport polls. */
type Stream = "issue_comment" | "pull_request_review_comment" | "issues" | "pull_request";

interface GithubAccount {
	appId: string;
	privateKey: string;
	botLogin: string;
	repositories: string[];
	triggers: ("mention" | "auto")[];
	pollIntervalMs?: number;
}

/** Pull the App credentials out of the resolved account record. */
function credentials(account: GithubAccount): AppCredentials {
	return { appId: account.appId, privateKey: account.privateKey };
}

// ============================================================================
// Watch-set + stream gate (the two named seams)
// ============================================================================

/**
 * Resolve the repos to watch: `account.repositories` with each repo's installation id, cached
 * in `ctx.store` under `installation:<owner>/<repo>` (an App is installed per org/user; tokens
 * are per-installation). A repo whose installation cannot be resolved is logged and skipped so
 * one bad entry never stalls the loop.
 */
async function getWatchedRepos(
	account: GithubAccount,
	store: KeyValueStore,
): Promise<Array<{ owner: string; repo: string; installationId: number }>> {
	const watched: Array<{ owner: string; repo: string; installationId: number }> = [];
	for (const full of account.repositories) {
		try {
			const { owner, repo } = parseRepo(full);
			const key = `installation:${owner}/${repo}`;
			let installationId = store.get(key) as number | undefined;
			if (installationId === undefined) {
				installationId = await resolveRepoInstallationId(credentials(account), owner, repo);
				store.set(key, installationId);
			}
			watched.push({ owner, repo, installationId });
		} catch (err) {
			console.error(`[github] skipping ${full}:`, err instanceof Error ? err.message : err);
		}
	}
	return watched;
}

/**
 * Whether a stream is polled. v1 enables all four; kept as the named seam for future per-stream
 * config so onboarding can stay "repos only" without a bind-a-workflow-but-forgot-the-toggle footgun.
 */
function isStreamEnabled(_stream: Stream): boolean {
	return true;
}

// ============================================================================
// Poll loop
// ============================================================================

/** Per-`since`-stream endpoint config. */
const SINCE_STREAMS: Array<{
	stream: Stream;
	subpath: string;
	stateAll: boolean;
	filter?: (raw: RawJson) => boolean;
	normalize: (repo: string, raw: RawJson) => unknown;
}> = [
	{ stream: "issue_comment", subpath: "/issues/comments", stateAll: false, normalize: normalizeIssueComment },
	{
		stream: "pull_request_review_comment",
		subpath: "/pulls/comments",
		stateAll: false,
		normalize: normalizeReviewComment,
	},
	{ stream: "issues", subpath: "/issues", stateAll: true, filter: (raw) => !raw.pull_request, normalize: normalizeIssue },
];

/**
 * Poll one `since`-based stream for one repo. Establishes a baseline cursor on the first run
 * (emits nothing), then on later ticks advances the cursor + boundary-id set and persists them
 * BEFORE emitting (at-most-once). Returns GitHub's `X-Poll-Interval` in ms when present.
 */
async function pollSinceStream(
	config: (typeof SINCE_STREAMS)[number],
	repoFull: string,
	token: string,
	store: KeyValueStore,
	emit: (event: string, data: unknown) => void,
): Promise<number | null> {
	const { stream, subpath, stateAll, filter, normalize } = config;
	const cursorKey = `cursor:${repoFull}:${stream}`;
	const seenKey = `seen:${repoFull}:${stream}`;
	const etagKey = `etag:${repoFull}:${stream}`;

	const cursor = store.get(cursorKey) as string | undefined;
	if (cursor === undefined) {
		// Baseline: only see items that arrive after install; no history replay.
		store.set(cursorKey, new Date().toISOString());
		store.set(seenKey, []);
		return null;
	}

	const etag = store.get(etagKey) as string | undefined;
	const query = `?since=${encodeURIComponent(cursor)}&sort=updated&direction=asc&per_page=100${
		stateAll ? "&state=all" : ""
	}`;
	const res = await githubRequest("GET", `/repos/${repoFull}${subpath}${query}`, { token, etag });
	if (res.status === 304) return res.pollIntervalMs;

	const rawItems = (parseJson<RawJson[]>(res.text) ?? []).filter((raw) => (filter ? filter(raw) : true));
	const items = rawItems.map((raw) => ({
		id: typeof raw.id === "number" ? raw.id : 0,
		ts: String(raw.updated_at),
		raw,
	}));
	const seenIds = (store.get(seenKey) as number[] | undefined) ?? [];
	const { toEmit, nextCursor, nextSeenIds } = selectSinceItems(items, cursor, seenIds);

	// Persist the advanced cursor before emitting so a crash right after an emit never re-fires.
	store.set(cursorKey, nextCursor);
	store.set(seenKey, nextSeenIds);
	if (res.etag) store.set(etagKey, res.etag);

	for (const it of toEmit) emit(stream, normalize(repoFull, it.raw));
	return res.pollIntervalMs;
}

/**
 * Poll the `pull_request` stream for one repo. The pulls list has no `since`, so items are
 * deduped by head SHA per PR number: a PR is emitted when its head advances or it is new. The
 * first run records current heads (emits nothing). Head map is persisted before emitting.
 */
async function pollPullRequests(
	repoFull: string,
	token: string,
	store: KeyValueStore,
	emit: (event: string, data: unknown) => void,
): Promise<number | null> {
	const etagKey = `etag:${repoFull}:pull_request`;
	const headsKey = `prHeads:${repoFull}`;
	const etag = store.get(etagKey) as string | undefined;
	const res = await githubRequest(
		"GET",
		`/repos/${repoFull}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
		{ token, etag },
	);
	if (res.status === 304) return res.pollIntervalMs;

	const rawItems = parseJson<RawJson[]>(res.text) ?? [];
	const items = rawItems.map((raw) => ({
		number: typeof raw.number === "number" ? raw.number : 0,
		headSha: readHeadSha(raw),
		raw,
	}));

	const prHeads = store.get(headsKey) as Record<string, string> | undefined;
	if (prHeads === undefined) {
		// Baseline: record current heads without emitting.
		const seeded: Record<string, string> = {};
		for (const it of items) seeded[String(it.number)] = it.headSha;
		store.set(headsKey, seeded);
		if (res.etag) store.set(etagKey, res.etag);
		return res.pollIntervalMs;
	}

	const { toEmit, nextPrHeads } = selectPullRequests(items, prHeads);
	store.set(headsKey, nextPrHeads);
	if (res.etag) store.set(etagKey, res.etag);

	for (const it of toEmit) emit("pull_request", normalizePullRequest(repoFull, it.raw));
	return res.pollIntervalMs;
}

/** One poll pass over every watched repo × enabled stream. Returns the max poll floor GitHub asked for. */
async function tick(
	account: GithubAccount,
	store: KeyValueStore,
	emit: (event: string, data: unknown) => void,
): Promise<number> {
	let pollFloorMs = 0;
	const note = (ms: number | null) => {
		if (ms && ms > pollFloorMs) pollFloorMs = ms;
	};

	for (const { owner, repo, installationId } of await getWatchedRepos(account, store)) {
		const repoFull = `${owner}/${repo}`;
		let token: string;
		try {
			token = await createInstallationToken(credentials(account), installationId);
		} catch (err) {
			console.error(`[github] token for ${repoFull} failed:`, err instanceof Error ? err.message : err);
			continue;
		}

		for (const config of SINCE_STREAMS) {
			if (!isStreamEnabled(config.stream)) continue;
			try {
				note(await pollSinceStream(config, repoFull, token, store, emit));
			} catch (err) {
				console.error(`[github] poll ${config.stream} ${repoFull} failed:`, err instanceof Error ? err.message : err);
			}
		}

		if (isStreamEnabled("pull_request")) {
			try {
				note(await pollPullRequests(repoFull, token, store, emit));
			} catch (err) {
				console.error(`[github] poll pull_request ${repoFull} failed:`, err instanceof Error ? err.message : err);
			}
		}
	}
	return pollFloorMs;
}

// ============================================================================
// Actions
// ============================================================================

/** Resolve (and cache) the installation token for a repo, then issue a repo-scoped REST call. */
async function repoRequest(
	account: GithubAccount,
	store: KeyValueStore,
	repoFull: string,
	method: string,
	subpath: string,
	options: { accept?: string; body?: unknown } = {},
): Promise<string> {
	const { owner, repo } = parseRepo(repoFull);
	const key = `installation:${owner}/${repo}`;
	let installationId = store.get(key) as number | undefined;
	if (installationId === undefined) {
		installationId = await resolveRepoInstallationId(credentials(account), owner, repo);
		store.set(key, installationId);
	}
	const token = await createInstallationToken(credentials(account), installationId);
	const res = await githubRequest(method, `/repos/${owner}/${repo}${subpath}`, {
		token,
		accept: options.accept,
		body: options.body,
	});
	return res.text;
}

// ============================================================================
// Onboarding
// ============================================================================

const ONBOARD_GUIDE = [
	"## Connect GitHub",
	"",
	"1. Create a **GitHub App** at https://github.com/settings/apps/new (or your org's",
	"   Developer settings). No webhook is needed — clear the **Webhook > Active** checkbox.",
	"2. Repository permissions: **Contents** read, **Issues** read+write,",
	"   **Pull requests** read+write, **Metadata** read.",
	"3. Under **Private keys**, generate a key and download the `.pem`.",
	"4. **Install** the App on the account/org that owns the repos you want to watch.",
	"5. On the next screens paste the App **ID**, the private key, the repos, and the triggers.",
].join("\n");

async function onboard(ctx: IntegrationOnboardContext): Promise<GithubAccount | undefined> {
	ctx.ui.notify(ONBOARD_GUIDE, "info");

	const appIdRaw = await ctx.ui.input("GitHub App ID (a number from the App's settings page)");
	if (appIdRaw === undefined) return undefined;
	const appId = appIdRaw.trim();
	if (!appId) {
		ctx.ui.notify("No App ID entered.", "error");
		return undefined;
	}

	const keyRaw = await ctx.ui.input("Private key: paste the PEM contents, or a $ENV / !cmd reference");
	if (keyRaw === undefined) return undefined;
	const privateKeyRef = keyRaw.trim();
	if (!privateKeyRef) {
		ctx.ui.notify("No private key entered.", "error");
		return undefined;
	}

	// Verify the credentials with a live GET /app, and read the App slug for botLogin.
	let botLogin: string;
	try {
		const privateKey = ctx.resolve(privateKeyRef) ?? privateKeyRef;
		const jwt = createAppJwt(appId, privateKey);
		const res = await githubRequest("GET", "/app", { token: jwt });
		const app = parseJson<{ slug?: string; name?: string }>(res.text);
		botLogin = typeof app?.slug === "string" ? app.slug : "";
		if (!botLogin) throw new Error("App response had no slug");
		ctx.ui.notify(`Verified GitHub App "${app?.name ?? botLogin}".`, "info");
	} catch (err) {
		ctx.ui.notify(`Could not verify the App: ${err instanceof Error ? err.message : String(err)}`, "error");
		return undefined;
	}

	const reposRaw = await ctx.ui.input("Repositories to watch, comma-separated (owner/repo, owner/repo)");
	if (reposRaw === undefined) return undefined;
	const candidates = reposRaw
		.split(",")
		.map((r) => r.trim())
		.filter((r) => r.length > 0);
	if (candidates.length === 0) {
		ctx.ui.notify("No repositories entered.", "error");
		return undefined;
	}

	// Validate each repo has the App installed; drop the ones that don't.
	const privateKey = ctx.resolve(privateKeyRef) ?? privateKeyRef;
	const repositories: string[] = [];
	for (const full of candidates) {
		try {
			const { owner, repo } = parseRepo(full);
			await resolveRepoInstallationId({ appId, privateKey }, owner, repo);
			repositories.push(`${owner}/${repo}`);
		} catch (err) {
			ctx.ui.notify(`Skipping ${full}: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}
	if (repositories.length === 0) {
		ctx.ui.notify("None of the repositories have the App installed.", "error");
		return undefined;
	}

	const triggers: ("mention" | "auto")[] = [];
	if (await ctx.ui.confirm("Triggers", `React when a comment @mentions @${botLogin}?`)) triggers.push("mention");
	if (await ctx.ui.confirm("Triggers", "Auto-review pull requests when they are opened or updated?")) {
		triggers.push("auto");
	}

	// Store the private key as the entered reference ($ENV / !cmd resolve on read), not the resolved secret.
	return { appId, privateKey: privateKeyRef, botLogin, repositories, triggers };
}

// ============================================================================
// Shared typebox fragments
// ============================================================================

const AuthorFields = {
	authorLogin: Type.String(),
	authorType: Type.String(),
};

export default defineIntegration({
	account: Type.Object({
		/** GitHub App ID. */
		appId: Type.String(),
		/** App private key (PEM). Onboarding stores the entered reference; `$ENV`/`!cmd` resolve on read. */
		privateKey: Type.String(),
		/** App slug — used for @mention detection and self/loop filtering in the workflow. */
		botLogin: Type.String(),
		/** Repos to watch, as `owner/repo`. */
		repositories: Type.Array(Type.String()),
		/** Enabled trigger modes. */
		triggers: Type.Array(Type.Union([Type.Literal("mention"), Type.Literal("auto")])),
		/** Poll interval floor in ms (honoring GitHub's `X-Poll-Interval`); default 60s. */
		pollIntervalMs: Type.Optional(Type.Number()),
	}),
	events: {
		issue_comment: Type.Object({
			repo: Type.String(),
			isPullRequest: Type.Boolean(),
			issueNumber: Type.Number(),
			commentId: Type.Number(),
			body: Type.String(),
			...AuthorFields,
			htmlUrl: Type.String(),
		}),
		pull_request_review_comment: Type.Object({
			repo: Type.String(),
			pullRequestNumber: Type.Number(),
			commentId: Type.Number(),
			inReplyToId: Type.Number(),
			body: Type.String(),
			...AuthorFields,
			htmlUrl: Type.String(),
		}),
		issues: Type.Object({
			repo: Type.String(),
			action: Type.String(),
			issueNumber: Type.Number(),
			title: Type.String(),
			...AuthorFields,
			htmlUrl: Type.String(),
		}),
		pull_request: Type.Object({
			repo: Type.String(),
			action: Type.String(),
			pullRequestNumber: Type.Number(),
			headSha: Type.String(),
			title: Type.String(),
			draft: Type.Boolean(),
			state: Type.String(),
			authorLogin: Type.String(),
			htmlUrl: Type.String(),
		}),
	},
	onboard,
	actions: {
		// --- Internal: the workflow reads config through this (actions get ctx.account) ---
		getSettings: {
			description: "Read the bot login and enabled triggers for routing decisions.",
			parameters: Type.Object({}),
			execute: async (_params, ctx) => {
				const account = ctx.account as GithubAccount;
				return { botLogin: account.botLogin, triggers: account.triggers };
			},
		},

		// --- Reads ---
		getPullRequest: {
			description: "Fetch pull-request metadata as JSON.",
			parameters: Type.Object({ repo: Type.String(), pullRequestNumber: Type.Number() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; pullRequestNumber: number };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "GET", `/pulls/${p.pullRequestNumber}`);
				return parseJson(text);
			},
		},
		getPullRequestDiff: {
			description: "Fetch the unified diff of a pull request.",
			parameters: Type.Object({ repo: Type.String(), pullRequestNumber: Type.Number() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; pullRequestNumber: number };
				const account = ctx.account as GithubAccount;
				const diff = await repoRequest(account, ctx.store, p.repo, "GET", `/pulls/${p.pullRequestNumber}`, {
					accept: "application/vnd.github.diff",
				});
				return { diff };
			},
		},
		listPullRequestFiles: {
			description: "List the files changed by a pull request.",
			parameters: Type.Object({ repo: Type.String(), pullRequestNumber: Type.Number() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; pullRequestNumber: number };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"GET",
					`/pulls/${p.pullRequestNumber}/files?per_page=100`,
				);
				return { files: parseJson(text) };
			},
		},
		checkoutPullRequest: {
			description:
				"Materialize a read-only checkout of a pull request's head commit under the agent workspace, so the agent can review the real source tree with its file tools. Fetches head + base (depth 1); configures no remote and never persists the token.",
			parameters: Type.Object({
				repo: Type.String(),
				pullRequestNumber: Type.Number(),
				destDir: Type.String(),
				headSha: Type.String(),
				baseSha: Type.String(),
			}),
			execute: async (params, ctx) => {
				const p = params as {
					repo: string;
					pullRequestNumber: number;
					destDir: string;
					headSha: string;
					baseSha: string;
				};
				const account = ctx.account as GithubAccount;
				const { owner, repo } = parseRepo(p.repo);
				// Resolve (and cache) the installation token here so it stays inside the action — it is
				// handed to git and never returned to the caller or written to disk.
				const key = `installation:${owner}/${repo}`;
				let installationId = ctx.store.get(key) as number | undefined;
				if (installationId === undefined) {
					installationId = await resolveRepoInstallationId(credentials(account), owner, repo);
					ctx.store.set(key, installationId);
				}
				const token = await createInstallationToken(credentials(account), installationId);
				await checkout({
					destDir: p.destDir,
					repo: `${owner}/${repo}`,
					token,
					headSha: p.headSha,
					baseSha: p.baseSha,
				});
				return { path: p.destDir };
			},
		},
		getIssue: {
			description: "Fetch issue metadata as JSON.",
			parameters: Type.Object({ repo: Type.String(), issueNumber: Type.Number() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; issueNumber: number };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "GET", `/issues/${p.issueNumber}`);
				return parseJson(text);
			},
		},
		getFileContent: {
			description: "Fetch a file's raw contents at an optional ref.",
			parameters: Type.Object({ repo: Type.String(), path: Type.String(), ref: Type.Optional(Type.String()) }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; path: string; ref?: string };
				const account = ctx.account as GithubAccount;
				const query = p.ref ? `?ref=${encodeURIComponent(p.ref)}` : "";
				const content = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"GET",
					`/contents/${p.path.split("/").map(encodeURIComponent).join("/")}${query}`,
					{ accept: "application/vnd.github.raw" },
				);
				return { content };
			},
		},
		listComments: {
			description: "List the timeline comments on an issue or pull request.",
			parameters: Type.Object({ repo: Type.String(), issueNumber: Type.Number() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; issueNumber: number };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"GET",
					`/issues/${p.issueNumber}/comments?per_page=100`,
				);
				return { comments: parseJson(text) };
			},
		},

		// --- Writes ---
		postComment: {
			description: "Post a timeline comment on an issue or pull request.",
			parameters: Type.Object({ repo: Type.String(), issueNumber: Type.Number(), body: Type.String() }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; issueNumber: number; body: string };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "POST", `/issues/${p.issueNumber}/comments`, {
					body: { body: p.body },
				});
				return parseJson(text);
			},
		},
		createReviewComment: {
			description: "Create an inline review comment on a pull request diff line.",
			parameters: Type.Object({
				repo: Type.String(),
				pullRequestNumber: Type.Number(),
				body: Type.String(),
				commitId: Type.String(),
				path: Type.String(),
				line: Type.Number(),
				side: Type.Optional(Type.String()),
			}),
			execute: async (params, ctx) => {
				const p = params as {
					repo: string;
					pullRequestNumber: number;
					body: string;
					commitId: string;
					path: string;
					line: number;
					side?: string;
				};
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "POST", `/pulls/${p.pullRequestNumber}/comments`, {
					body: { body: p.body, commit_id: p.commitId, path: p.path, line: p.line, side: p.side ?? "RIGHT" },
				});
				return parseJson(text);
			},
		},
		submitReview: {
			description: "Submit a pull-request review (COMMENT / APPROVE / REQUEST_CHANGES).",
			parameters: Type.Object({
				repo: Type.String(),
				pullRequestNumber: Type.Number(),
				event: Type.Union([Type.Literal("COMMENT"), Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES")]),
				body: Type.Optional(Type.String()),
			}),
			execute: async (params, ctx) => {
				const p = params as {
					repo: string;
					pullRequestNumber: number;
					event: string;
					body?: string;
				};
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "POST", `/pulls/${p.pullRequestNumber}/reviews`, {
					body: { event: p.event, body: p.body },
				});
				return parseJson(text);
			},
		},
		replyToReviewComment: {
			description: "Reply to an inline pull-request review comment thread.",
			parameters: Type.Object({
				repo: Type.String(),
				pullRequestNumber: Type.Number(),
				commentId: Type.Number(),
				body: Type.String(),
			}),
			execute: async (params, ctx) => {
				const p = params as { repo: string; pullRequestNumber: number; commentId: number; body: string };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"POST",
					`/pulls/${p.pullRequestNumber}/comments/${p.commentId}/replies`,
					{ body: { body: p.body } },
				);
				return parseJson(text);
			},
		},
		addReaction: {
			description: "Add a reaction emoji to an issue comment or review comment.",
			parameters: Type.Object({
				repo: Type.String(),
				subject: Type.Union([Type.Literal("issue_comment"), Type.Literal("pull_request_review_comment")]),
				commentId: Type.Number(),
				content: Type.String(),
			}),
			execute: async (params, ctx) => {
				const p = params as {
					repo: string;
					subject: "issue_comment" | "pull_request_review_comment";
					commentId: number;
					content: string;
				};
				const account = ctx.account as GithubAccount;
				const segment = p.subject === "issue_comment" ? "issues/comments" : "pulls/comments";
				const text = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"POST",
					`/${segment}/${p.commentId}/reactions`,
					{ body: { content: p.content } },
				);
				return parseJson(text);
			},
		},
		addLabels: {
			description: "Add labels to an issue or pull request.",
			parameters: Type.Object({ repo: Type.String(), issueNumber: Type.Number(), labels: Type.Array(Type.String()) }),
			execute: async (params, ctx) => {
				const p = params as { repo: string; issueNumber: number; labels: string[] };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "POST", `/issues/${p.issueNumber}/labels`, {
					body: { labels: p.labels },
				});
				return parseJson(text);
			},
		},
		requestReviewers: {
			description: "Request reviewers on a pull request.",
			parameters: Type.Object({
				repo: Type.String(),
				pullRequestNumber: Type.Number(),
				reviewers: Type.Array(Type.String()),
			}),
			execute: async (params, ctx) => {
				const p = params as { repo: string; pullRequestNumber: number; reviewers: string[] };
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(
					account,
					ctx.store,
					p.repo,
					"POST",
					`/pulls/${p.pullRequestNumber}/requested_reviewers`,
					{ body: { reviewers: p.reviewers } },
				);
				return parseJson(text);
			},
		},
		setCommitStatus: {
			description: "Set a commit status on a SHA.",
			parameters: Type.Object({
				repo: Type.String(),
				sha: Type.String(),
				state: Type.Union([
					Type.Literal("error"),
					Type.Literal("failure"),
					Type.Literal("pending"),
					Type.Literal("success"),
				]),
				context: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				targetUrl: Type.Optional(Type.String()),
			}),
			execute: async (params, ctx) => {
				const p = params as {
					repo: string;
					sha: string;
					state: string;
					context?: string;
					description?: string;
					targetUrl?: string;
				};
				const account = ctx.account as GithubAccount;
				const text = await repoRequest(account, ctx.store, p.repo, "POST", `/statuses/${p.sha}`, {
					body: { state: p.state, context: p.context, description: p.description, target_url: p.targetUrl },
				});
				return parseJson(text);
			},
		},
	},
	run(ctx) {
		const account = ctx.account as GithubAccount;
		if (account.repositories.length === 0) {
			console.warn("[github] no repositories configured — the poller has nothing to watch.");
		}

		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pollFloorMs = 0;

		const loop = async (): Promise<void> => {
			if (stopped || ctx.signal.aborted) return;
			try {
				// Swallow per-tick errors so one failure never stops the loop (telegram's posture).
				pollFloorMs = await tick(account, ctx.store, (event, data) => ctx.emit(event as Stream, data as never));
			} catch (err) {
				console.error("[github] poll tick failed:", err instanceof Error ? err.message : err);
			}
			if (stopped || ctx.signal.aborted) return;
			const delay = Math.max(account.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, pollFloorMs);
			timer = setTimeout(() => void loop(), delay);
		};

		// Fire-and-forget; the first pass is the catch-up tick (resumes from the stored cursor).
		void loop();

		const dispose = () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
		ctx.signal.addEventListener("abort", dispose);
		return dispose;
	},
});
