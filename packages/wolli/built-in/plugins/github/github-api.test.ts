import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	chunkComment,
	clearInstallationTokenCache,
	createAppJwt,
	createInstallationToken,
	extractMention,
	githubRequest,
	GITHUB_COMMENT_MARKER,
	isIgnoredInboundComment,
	normalizeIssue,
	normalizeIssueComment,
	normalizePullRequest,
	normalizeReviewComment,
	parseThreadTag,
	selectPullRequests,
	selectSinceItems,
} from "./github-api.ts";

function keyPair(): { privateKey: string; publicKey: string } {
	const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return {
		privateKey: generated.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		publicKey: generated.publicKey.export({ format: "pem", type: "spki" }).toString(),
	};
}

describe("createAppJwt", () => {
	it("produces a valid RS256 JWT with the right iss/iat/exp", () => {
		const { privateKey, publicKey } = keyPair();
		const nowMs = Date.parse("2026-06-01T00:00:00Z");
		const jwt = createAppJwt("12345", privateKey, nowMs);
		const [header, payload, signature] = jwt.split(".");

		expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toMatchObject({
			alg: "RS256",
			typ: "JWT",
		});
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const nowSeconds = Math.floor(nowMs / 1000);
		expect(claims.iss).toBe("12345");
		expect(claims.iat).toBe(nowSeconds - 60);
		expect(claims.exp).toBe(nowSeconds + 600);

		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"))).toBe(true);
	});
});

describe("createInstallationToken", () => {
	beforeEach(() => clearInstallationTokenCache());

	it("exchanges and caches installation tokens", async () => {
		const { privateKey } = keyPair();
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ token: "ghs_installation", expires_at: "2099-06-01T01:00:00Z" })),
		);

		const first = await createInstallationToken({ appId: "1", privateKey }, 99, {
			baseUrl: "https://github.test",
			fetchImpl: fetchMock,
		});
		const second = await createInstallationToken({ appId: "1", privateKey }, 99, {
			baseUrl: "https://github.test",
			fetchImpl: fetchMock,
		});

		expect(first).toBe("ghs_installation");
		expect(second).toBe("ghs_installation");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("https://github.test/app/installations/99/access_tokens");
	});
});

describe("githubRequest", () => {
	it("returns a 304 without throwing so a conditional poll can skip", async () => {
		// The Response constructor forbids a 304 (null-body) status, so mock the shape githubRequest reads.
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 304,
			headers: new Headers(),
			text: async () => "",
		});
		const res = await githubRequest("GET", "/repos/o/r/issues/comments", {
			token: "t",
			etag: '"abc"',
			fetchImpl: fetchMock,
		});
		expect(res.status).toBe(304);
		expect(new Headers(fetchMock.mock.calls[0][1].headers).get("if-none-match")).toBe('"abc"');
	});

	it("surfaces the X-Poll-Interval header in ms and the etag", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("[]", { status: 200, headers: { etag: '"e"', "x-poll-interval": "90" } }));
		const res = await githubRequest("GET", "/x", { fetchImpl: fetchMock });
		expect(res.etag).toBe('"e"');
		expect(res.pollIntervalMs).toBe(90_000);
	});

	it("throws on a non-2xx that is not 304", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
		await expect(githubRequest("GET", "/x", { fetchImpl: fetchMock })).rejects.toThrow(/HTTP 404/);
	});
});

describe("normalizers", () => {
	it("marks a PR timeline comment and reads the issue number from issue_url", () => {
		const payload = normalizeIssueComment("o/r", {
			id: 5,
			body: "hi",
			html_url: "https://github.com/o/r/pull/12#issuecomment-5",
			issue_url: "https://api.github.com/repos/o/r/issues/12",
			user: { login: "alice", type: "User" },
		});
		expect(payload).toMatchObject({
			repo: "o/r",
			isPullRequest: true,
			issueNumber: 12,
			commentId: 5,
			authorLogin: "alice",
			authorType: "User",
		});
	});

	it("treats an /issues/ comment as not a pull request", () => {
		const payload = normalizeIssueComment("o/r", {
			id: 6,
			html_url: "https://github.com/o/r/issues/7#issuecomment-6",
			issue_url: "https://api.github.com/repos/o/r/issues/7",
		});
		expect(payload.isPullRequest).toBe(false);
		expect(payload.issueNumber).toBe(7);
	});

	it("reads the PR number from a review comment's pull_request_url", () => {
		const payload = normalizeReviewComment("o/r", {
			id: 9,
			in_reply_to_id: 8,
			pull_request_url: "https://api.github.com/repos/o/r/pulls/34",
			user: { login: "bob", type: "User" },
		});
		expect(payload).toMatchObject({ pullRequestNumber: 34, commentId: 9, inReplyToId: 8 });
	});

	it("synthesizes a best-effort action for issues", () => {
		expect(normalizeIssue("o/r", { number: 1, created_at: "t", updated_at: "t" }).action).toBe("opened");
		expect(normalizeIssue("o/r", { number: 1, created_at: "t", updated_at: "u" }).action).toBe("edited");
		expect(normalizeIssue("o/r", { number: 1, state: "closed" }).action).toBe("closed");
	});

	it("reads the head SHA and draft flag for pull requests", () => {
		const payload = normalizePullRequest("o/r", {
			number: 3,
			head: { sha: "deadbeef" },
			draft: true,
			state: "open",
			created_at: "t",
			updated_at: "t",
			user: { login: "carol" },
		});
		expect(payload).toMatchObject({ pullRequestNumber: 3, headSha: "deadbeef", draft: true, action: "opened" });
	});
});

describe("mention + loop gating", () => {
	it("strips the bot mention and returns the message", () => {
		expect(extractMention("@mybot please review", "mybot")).toEqual({ message: "please review" });
		expect(extractMention("hey @mybot look here", "mybot")).toEqual({ message: "hey  look here" });
	});

	it("returns null when the bot is not mentioned", () => {
		expect(extractMention("no mention here", "mybot")).toBeNull();
		expect(extractMention("@other do it", "mybot")).toBeNull();
	});

	it("ignores our own marker, other bots, and our own bot login", () => {
		expect(isIgnoredInboundComment(`done ${GITHUB_COMMENT_MARKER}`, "someone", "User", "mybot")).toBe(true);
		expect(isIgnoredInboundComment("x", "some-bot", "Bot", "mybot")).toBe(true);
		expect(isIgnoredInboundComment("x", "mybot[bot]", "User", "mybot")).toBe(true);
		expect(isIgnoredInboundComment("@mybot hi", "human", "User", "mybot")).toBe(false);
	});
});

describe("chunkComment", () => {
	it("returns a single chunk when short", () => {
		expect(chunkComment("hello", 100)).toEqual(["hello"]);
	});

	it("splits over the limit into bounded chunks", () => {
		const body = "a".repeat(250);
		const chunks = chunkComment(body, 100);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
	});
});

describe("parseThreadTag", () => {
	it("splits owner/repo#number", () => {
		expect(parseThreadTag("acme/widgets#42")).toEqual({ repo: "acme/widgets", number: 42 });
	});
});

describe("selectSinceItems", () => {
	it("emits strictly-newer items and advances the cursor", () => {
		const result = selectSinceItems(
			[
				{ id: 1, ts: "2026-01-01T00:00:00Z" },
				{ id: 2, ts: "2026-01-01T00:00:05Z" },
			],
			"2026-01-01T00:00:00Z",
			[1],
		);
		expect(result.toEmit.map((i) => i.id)).toEqual([2]);
		expect(result.nextCursor).toBe("2026-01-01T00:00:05Z");
		expect(result.nextSeenIds).toEqual([2]);
	});

	it("emits a genuinely-new same-second item but not an already-seen one", () => {
		const result = selectSinceItems(
			[
				{ id: 1, ts: "2026-01-01T00:00:00Z" },
				{ id: 2, ts: "2026-01-01T00:00:00Z" },
			],
			"2026-01-01T00:00:00Z",
			[1],
		);
		expect(result.toEmit.map((i) => i.id)).toEqual([2]);
		expect(result.nextCursor).toBe("2026-01-01T00:00:00Z");
		expect(result.nextSeenIds.sort()).toEqual([1, 2]);
	});

	it("emits nothing on a boundary re-fetch of already-seen items", () => {
		const result = selectSinceItems([{ id: 1, ts: "2026-01-01T00:00:00Z" }], "2026-01-01T00:00:00Z", [1]);
		expect(result.toEmit).toEqual([]);
		expect(result.nextCursor).toBe("2026-01-01T00:00:00Z");
	});
});

describe("selectPullRequests", () => {
	it("emits new and head-advanced PRs, skips unchanged, and rebuilds the head map", () => {
		const result = selectPullRequests(
			[
				{ number: 1, headSha: "aaa" },
				{ number: 2, headSha: "ccc" },
			],
			{ "1": "aaa", "2": "bbb" },
		);
		expect(result.toEmit.map((p) => p.number)).toEqual([2]);
		expect(result.nextPrHeads).toEqual({ "1": "aaa", "2": "ccc" });
	});

	it("emits a brand-new PR", () => {
		const result = selectPullRequests([{ number: 9, headSha: "zzz" }], {});
		expect(result.toEmit.map((p) => p.number)).toEqual([9]);
	});
});
