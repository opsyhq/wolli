/**
 * GitHub App auth + REST + normalization helpers for the polling integration.
 *
 * This module holds every piece of the transport that does NOT depend on the wolli host:
 * the App JWT (RS256 via `node:crypto`), the installation-token exchange + cache, the thin
 * `fetch`-based REST wrapper, the raw-JSON normalizers, the `@mention` / loop-prevention
 * gating, and the pure cursor-selection logic the poll loop drives. Keeping it host-free
 * (no `import ... from "wolli"`) is what makes it unit-testable on its own — `index.ts`
 * imports these into the `defineIntegration(...)` transport and `github-chat.ts` imports
 * the gating helpers into the routing workflows.
 *
 * GitHub App auth is standard and implemented in-repo (no third-party SDK): a short-lived
 * RS256 JWT signed with the App private key, exchanged per installation for a ~1h token.
 * The eve `channels/github/{auth,api,inbound}.ts` sources are the working reference these
 * calls were ported from.
 */

import { createSign } from "node:crypto";

/** GitHub REST base. */
export const GITHUB_API_BASE = "https://api.github.com";

/** X-GitHub-Api-Version the calls pin to. */
const GITHUB_API_VERSION = "2022-11-28";

/** GitHub caps a single issue/PR comment body at 65536 characters. */
export const GITHUB_COMMENT_MAX_LENGTH = 65_536;

/** Default poll floor when the account sets none and GitHub returns no X-Poll-Interval. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Refresh an installation token this far before its reported expiry. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Loop-prevention marker appended to every comment the agent posts. */
export const GITHUB_COMMENT_MARKER = "<!-- wolli:github -->";

/** Error thrown for a non-2xx (and non-304) GitHub REST response. */
export class GithubApiError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(method: string, path: string, status: number, body: string) {
		super(`GitHub ${method} ${path} failed with HTTP ${status}`);
		this.name = "GithubApiError";
		this.status = status;
		this.body = body;
	}
}

/** Options for the low-level {@link githubRequest} wrapper. */
export interface GithubRequestOptions {
	/** Bearer token: an installation token or an App JWT. */
	token?: string;
	/** Override the default `application/vnd.github+json` Accept (e.g. the diff or raw media type). */
	accept?: string;
	/** JSON request body; serialized and sent with a JSON content-type. */
	body?: unknown;
	/** ETag for a conditional request; a matching resource returns 304. */
	etag?: string;
	/** Override the API base (tests point this at a mock server). */
	baseUrl?: string;
	/** Override the fetch implementation (tests inject a mock). */
	fetchImpl?: typeof fetch;
}

/** A GitHub REST response, body left as text so diff/raw media types pass through unparsed. */
export interface GithubResponse {
	status: number;
	etag: string | null;
	/** `X-Poll-Interval` in ms when GitHub returned one, else null. */
	pollIntervalMs: number | null;
	text: string;
}

/** Thin REST wrapper. Throws {@link GithubApiError} on non-2xx except 304 (returned to the caller). */
export async function githubRequest(
	method: string,
	path: string,
	options: GithubRequestOptions = {},
): Promise<GithubResponse> {
	const doFetch = options.fetchImpl ?? fetch;
	const headers: Record<string, string> = {
		accept: options.accept ?? "application/vnd.github+json",
		"x-github-api-version": GITHUB_API_VERSION,
		"user-agent": "wolli-github-integration",
	};
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	if (options.etag) headers["if-none-match"] = options.etag;
	if (options.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";

	const response = await doFetch(`${options.baseUrl ?? GITHUB_API_BASE}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	if (!response.ok && response.status !== 304) {
		throw new GithubApiError(method, path, response.status, text);
	}
	const poll = response.headers.get("x-poll-interval");
	return {
		status: response.status,
		etag: response.headers.get("etag"),
		pollIntervalMs: poll ? Number(poll) * 1000 : null,
		text,
	};
}

/** Parse a JSON response body, throwing a contextual error if it is not valid JSON. */
export function parseJson<T = unknown>(text: string): T {
	if (!text) return null as T;
	return JSON.parse(text) as T;
}

// ============================================================================
// App auth
// ============================================================================

/** Convert hosted-platform escaped newlines back into PEM newlines. */
export function normalizePrivateKey(privateKey: string): string {
	return privateKey.replace(/\\n/g, "\n");
}

function base64UrlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Mint a short-lived RS256 GitHub App JWT (`iss` = app id, ~10-min expiry, `iat` backdated
 * 60s for clock skew). `nowMs` is injectable so tests assert a deterministic `iat`/`exp`.
 */
export function createAppJwt(appId: string, privateKey: string, nowMs: number = Date.now()): string {
	const nowSeconds = Math.floor(nowMs / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat: nowSeconds - 60, exp: nowSeconds + 10 * 60, iss: appId };
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
	const signature = createSign("RSA-SHA256").update(signingInput).sign(normalizePrivateKey(privateKey), "base64url");
	return `${signingInput}.${signature}`;
}

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

/** Process-memory installation-token cache, keyed by `${appId}:${installationId}`. */
const installationTokenCache = new Map<string, CachedToken>();

/** Clear the installation-token cache. Intended for tests. */
export function clearInstallationTokenCache(): void {
	installationTokenCache.clear();
}

/** Credentials the App-auth helpers need. */
export interface AppCredentials {
	appId: string;
	privateKey: string;
}

/**
 * Exchange the App JWT for a per-installation access token, cached in process memory until
 * ~1 min before GitHub's reported expiry. `POST /app/installations/{id}/access_tokens`.
 */
export async function createInstallationToken(
	credentials: AppCredentials,
	installationId: number,
	options: { baseUrl?: string; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<string> {
	const now = options.nowMs ?? Date.now();
	const cacheKey = `${credentials.appId}:${installationId}`;
	const cached = installationTokenCache.get(cacheKey);
	if (cached && now < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
		return cached.token;
	}

	const jwt = createAppJwt(credentials.appId, credentials.privateKey, now);
	const result = await githubRequest("POST", `/app/installations/${installationId}/access_tokens`, {
		token: jwt,
		baseUrl: options.baseUrl,
		fetchImpl: options.fetchImpl,
	});
	const body = parseJson<{ token?: string; expires_at?: string }>(result.text);
	if (!body || typeof body.token !== "string") {
		throw new Error("github: installation token response did not include a token");
	}
	const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : now + 60 * 60 * 1000;
	installationTokenCache.set(cacheKey, {
		token: body.token,
		expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now + 60 * 60 * 1000,
	});
	return body.token;
}

/**
 * Resolve the installation id an App holds over a repo: `GET /repos/{o}/{r}/installation`
 * authenticated with the App JWT. An App is installed per org/user; tokens are per-installation.
 */
export async function resolveRepoInstallationId(
	credentials: AppCredentials,
	owner: string,
	repo: string,
	options: { baseUrl?: string; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<number> {
	const jwt = createAppJwt(credentials.appId, credentials.privateKey, options.nowMs ?? Date.now());
	const result = await githubRequest("GET", `/repos/${owner}/${repo}/installation`, {
		token: jwt,
		baseUrl: options.baseUrl,
		fetchImpl: options.fetchImpl,
	});
	const body = parseJson<{ id?: number }>(result.text);
	if (!body || typeof body.id !== "number") {
		throw new Error(`github: no installation id for ${owner}/${repo} (is the App installed there?)`);
	}
	return body.id;
}

// ============================================================================
// Repo / thread parsing
// ============================================================================

/** Split `"owner/repo"`; throws on a malformed value. */
export function parseRepo(full: string): { owner: string; repo: string } {
	const [owner, repo] = full.split("/");
	if (!owner || !repo) throw new Error(`github: invalid repository "${full}" (expected "owner/repo")`);
	return { owner, repo };
}

/** Parse a `github:thread` tag (`"owner/repo#123"`) back into its parts. */
export function parseThreadTag(tag: string): { repo: string; number: number } {
	const hash = tag.lastIndexOf("#");
	if (hash === -1) throw new Error(`github: invalid thread tag "${tag}"`);
	const repo = tag.slice(0, hash);
	const number = Number(tag.slice(hash + 1));
	if (!repo || !Number.isFinite(number)) throw new Error(`github: invalid thread tag "${tag}"`);
	return { repo, number };
}

/** Extract the issue/PR number from a GitHub API resource URL (`.../issues/123`, `.../pulls/45`). */
function numberFromUrl(url: string | undefined, segment: string): number {
	if (!url) return 0;
	const match = new RegExp(`/${segment}/(\\d+)`).exec(url);
	return match ? Number(match[1]) : 0;
}

// ============================================================================
// Normalizers (raw GitHub JSON -> lean emitted payloads)
// ============================================================================

/** A decoded, still-untyped GitHub JSON object. */
export type RawJson = Record<string, unknown>;

function isRecord(value: unknown): value is RawJson {
	return typeof value === "object" && value !== null;
}

/** Read the `.user` actor login/type off any GitHub resource object. */
function readAuthor(raw: RawJson): { authorLogin: string; authorType: string } {
	const user = isRecord(raw.user) ? raw.user : {};
	return {
		authorLogin: typeof user.login === "string" ? user.login : "",
		authorType: typeof user.type === "string" ? user.type : "User",
	};
}

/** Read `.head.sha` off a raw pull-request object (`""` when absent). */
export function readHeadSha(raw: RawJson): string {
	const head = isRecord(raw.head) ? raw.head : {};
	return typeof head.sha === "string" ? head.sha : "";
}

/** Normalized issue/PR timeline comment (`issue_comment` stream). */
export interface IssueCommentPayload {
	repo: string;
	isPullRequest: boolean;
	issueNumber: number;
	commentId: number;
	body: string;
	authorLogin: string;
	authorType: string;
	htmlUrl: string;
}

export function normalizeIssueComment(repo: string, raw: RawJson): IssueCommentPayload {
	const htmlUrl = typeof raw.html_url === "string" ? raw.html_url : "";
	return {
		repo,
		isPullRequest: htmlUrl.includes("/pull/"),
		issueNumber: numberFromUrl(typeof raw.issue_url === "string" ? raw.issue_url : htmlUrl, "issues"),
		commentId: typeof raw.id === "number" ? raw.id : 0,
		body: typeof raw.body === "string" ? raw.body : "",
		...readAuthor(raw),
		htmlUrl,
	};
}

/** Normalized inline PR review comment (`pull_request_review_comment` stream). */
export interface ReviewCommentPayload {
	repo: string;
	pullRequestNumber: number;
	commentId: number;
	inReplyToId: number;
	body: string;
	authorLogin: string;
	authorType: string;
	htmlUrl: string;
}

export function normalizeReviewComment(repo: string, raw: RawJson): ReviewCommentPayload {
	return {
		repo,
		pullRequestNumber: numberFromUrl(typeof raw.pull_request_url === "string" ? raw.pull_request_url : "", "pulls"),
		commentId: typeof raw.id === "number" ? raw.id : 0,
		inReplyToId: typeof raw.in_reply_to_id === "number" ? raw.in_reply_to_id : 0,
		body: typeof raw.body === "string" ? raw.body : "",
		...readAuthor(raw),
		htmlUrl: typeof raw.html_url === "string" ? raw.html_url : "",
	};
}

/** Best-effort webhook-style action for a polled issue (no webhook `action` exists). */
function issueAction(raw: RawJson): string {
	if (raw.state === "closed") return "closed";
	if (raw.created_at && raw.created_at === raw.updated_at) return "opened";
	return "edited";
}

/** Normalized issue (`issues` stream). PRs surfacing in the issues list are filtered out upstream. */
export interface IssuePayload {
	repo: string;
	action: string;
	issueNumber: number;
	title: string;
	authorLogin: string;
	authorType: string;
	htmlUrl: string;
}

export function normalizeIssue(repo: string, raw: RawJson): IssuePayload {
	return {
		repo,
		action: issueAction(raw),
		issueNumber: typeof raw.number === "number" ? raw.number : 0,
		title: typeof raw.title === "string" ? raw.title : "",
		...readAuthor(raw),
		htmlUrl: typeof raw.html_url === "string" ? raw.html_url : "",
	};
}

/** Best-effort webhook-style action for a polled PR (no webhook `action` exists). */
function pullRequestAction(raw: RawJson): string {
	if (raw.state === "closed") return "closed";
	if (raw.created_at && raw.created_at === raw.updated_at) return "opened";
	return "synchronize";
}

/** Normalized pull request (`pull_request` stream). */
export interface PullRequestPayload {
	repo: string;
	action: string;
	pullRequestNumber: number;
	headSha: string;
	title: string;
	draft: boolean;
	state: string;
	authorLogin: string;
	htmlUrl: string;
}

export function normalizePullRequest(repo: string, raw: RawJson): PullRequestPayload {
	return {
		repo,
		action: pullRequestAction(raw),
		pullRequestNumber: typeof raw.number === "number" ? raw.number : 0,
		headSha: typeof raw.head?.sha === "string" ? raw.head.sha : "",
		title: typeof raw.title === "string" ? raw.title : "",
		draft: raw.draft === true,
		state: typeof raw.state === "string" ? raw.state : "",
		authorLogin: readAuthor(raw).authorLogin,
		htmlUrl: typeof raw.html_url === "string" ? raw.html_url : "",
	};
}

// ============================================================================
// Mention + loop-prevention gating
// ============================================================================

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when an inbound comment must NOT wake the agent: it carries our own marker, is
 * authored by a Bot, or is authored by this App's own bot login (`<slug>[bot]`). This is
 * the loop guard — the App's own replies would otherwise re-trigger the mention path.
 */
export function isIgnoredInboundComment(
	body: string,
	authorLogin: string,
	authorType: string,
	botLogin: string,
): boolean {
	if (body.includes(GITHUB_COMMENT_MARKER)) return true;
	if (authorType === "Bot") return true;
	const self = botLogin ? `${botLogin}[bot]`.toLowerCase() : "";
	return self.length > 0 && authorLogin.toLowerCase() === self;
}

/**
 * If `body` @mentions `botLogin`, return the body with that mention stripped (the message
 * to route to the agent); else null. Matches `@slug` on a word boundary, case-insensitively.
 */
export function extractMention(body: string, botLogin: string): { message: string } | null {
	const login = botLogin.trim();
	if (!login) return null;
	const match = new RegExp(`@${escapeRegExp(login)}(?=$|[^A-Za-z0-9_-])`, "i").exec(body);
	if (!match) return null;
	const message = `${body.slice(0, match.index)}${body.slice(match.index + match[0].length)}`.trim();
	return { message };
}

/** Split a comment body into GitHub-sized chunks, preferring newline/space boundaries. */
export function chunkComment(body: string, max = GITHUB_COMMENT_MAX_LENGTH): string[] {
	if (body.length <= max) return [body];
	const chunks: string[] = [];
	let remaining = body;
	while (remaining.length > max) {
		let splitAt = remaining.lastIndexOf("\n", max);
		if (splitAt <= max * 0.5) splitAt = remaining.lastIndexOf(" ", max);
		if (splitAt <= max * 0.5) splitAt = max;
		chunks.push(remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

// ============================================================================
// Pure cursor selection (drives the poll loop; unit-tested in isolation)
// ============================================================================

/** One polled item reduced to the two fields the cursor logic needs. */
export interface CursorItem {
	id: number;
	/** ISO-8601 `updated_at`. */
	ts: string;
}

/**
 * Given items from a `?since=<cursor>` fetch, the stored `cursor` (max `updated_at` emitted
 * so far), and `seenIds` (ids observed exactly at `cursor`), return the items to emit plus
 * the advanced cursor/seen state. Emits anything strictly newer than the cursor, plus any
 * same-second item whose id was not already seen — so a boundary re-fetch never re-emits,
 * and a genuinely new same-second item is not dropped.
 */
export function selectSinceItems<T extends CursorItem>(
	items: T[],
	cursor: string,
	seenIds: number[],
): { toEmit: T[]; nextCursor: string; nextSeenIds: number[] } {
	const seen = new Set(seenIds);
	const sorted = [...items].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	const toEmit = sorted.filter((it) => it.ts > cursor || (it.ts === cursor && !seen.has(it.id)));

	let nextCursor = cursor;
	for (const it of sorted) if (it.ts > nextCursor) nextCursor = it.ts;

	const atBoundary = sorted.filter((it) => it.ts === nextCursor).map((it) => it.id);
	const nextSeenIds = nextCursor === cursor ? [...new Set([...seenIds, ...atBoundary])] : atBoundary;
	return { toEmit, nextCursor, nextSeenIds };
}

/** One polled PR reduced to the fields the head-SHA dedupe needs. */
export interface PullRequestCursorItem {
	number: number;
	headSha: string;
}

/**
 * Given the current PR list and the last-emitted head SHA per PR number, return the PRs whose
 * head advanced (or are new) plus the refreshed head map. Rebuilding the map from the fetch
 * bounds it to the recent-updates window rather than growing without limit.
 */
export function selectPullRequests<T extends PullRequestCursorItem>(
	items: T[],
	prHeads: Record<string, string>,
): { toEmit: T[]; nextPrHeads: Record<string, string> } {
	const toEmit = items.filter((it) => prHeads[String(it.number)] !== it.headSha);
	const nextPrHeads: Record<string, string> = {};
	for (const it of items) nextPrHeads[String(it.number)] = it.headSha;
	return { toEmit, nextPrHeads };
}
