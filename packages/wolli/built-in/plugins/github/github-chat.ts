/**
 * GitHub chat routing, as one workflows file. It maps the transport's generic events onto
 * per-conversation sessions and ships replies back as comments; the transport itself never
 * touches a session.
 *
 *  - `inboundIssueComment` / `inboundReviewComment` bind each issue/PR conversation to its own
 *    session by a `github:thread` tag and deliver an @mention as a followUp — gated on the
 *    `mention` trigger and the self/bot/marker loop guard. The summoning comment gets an `eyes`
 *    reaction as an acknowledgment, and when the mention is on a pull request the PR's source is
 *    checked out (see `buildReviewTurn`) so the agent reviews real code with its own file tools.
 *  - `auto` seeds a "review this PR" turn when a PR is opened/updated, gated on the `auto`
 *    trigger and deduped on head SHA via a session tag so the same commits are reviewed once.
 *  - `reply` ships the turn's final assistant text back as a comment on `agent_end`, riding the
 *    producing session's `github:thread` tag, chunked to GitHub's comment size limit and tagged
 *    with the loop-prevention marker.
 */

import { type WorkflowContext, wolli } from "wolli";
import {
	chunkComment,
	extractMention,
	GITHUB_COMMENT_MARKER,
	isIgnoredInboundComment,
	parseThreadTag,
} from "./github-api.ts";
import { reviewPaths } from "./github-workspace.ts";
import github from "./index.ts";

/**
 * Check the pull request out under the agent workspace and return the review turn to send (plus the
 * head SHA, which the caller records on the session so the review tool can anchor inline comments):
 * the `lead` (the reviewer's actual ask), then where the working copy is and how to diff it. The
 * agent reads and greps the real tree — nothing about the code is pasted into the prompt.
 */
async function buildReviewTurn(
	ctx: WorkflowContext,
	repo: string,
	pullRequestNumber: number,
	lead: string,
): Promise<{ message: string; headSha: string }> {
	const api = ctx.integration(github);
	const [pr, filesResult] = await Promise.all([
		api.getPullRequest({ repo, pullRequestNumber }) as Promise<{
			title?: string;
			body?: string;
			head?: { sha?: string };
			base?: { sha?: string };
		} | null>,
		api.listPullRequestFiles({ repo, pullRequestNumber }) as Promise<{
			files?: Array<{ filename?: string }>;
		} | null>,
	]);

	const headSha = pr?.head?.sha ?? "";
	const baseSha = pr?.base?.sha ?? "";
	const { absDir, relDir } = reviewPaths(ctx.agent.cwd, repo, pullRequestNumber);
	await api.checkoutPullRequest({ repo, pullRequestNumber, destDir: absDir, headSha, baseSha });

	const changed = (filesResult?.files ?? []).map((f) => `  ${f.filename ?? "?"}`).join("\n");
	const body = (pr?.body ?? "").trim();

	const message = [
		lead,
		"",
		`Repository: ${repo}   Pull request #${pullRequestNumber}: ${pr?.title ?? ""}`.trimEnd(),
		...(body ? [`Description: ${body.slice(0, 2000)}`] : []),
		"",
		`A read-only checkout of the head commit is at ${relDir} (relative to your working directory).`,
		"You have the full source tree — read any file, and grep the tree to check for duplication or",
		"to see how the changed code is used elsewhere.",
		"",
		`See exactly what changed:  git -C ${relDir} diff ${baseSha} ${headSha}`,
		"",
		"Files changed in this PR:",
		changed || "  (none reported)",
		"",
		"Review for correctness, code duplication, and potential bugs. Leave each finding as an inline",
		'comment on the exact line with the github_review tool (action "comment"), then submit your',
		'verdict with action "submit" (REQUEST_CHANGES if there are real problems, otherwise COMMENT).',
	].join("\n");
	return { message, headSha };
}

/** Route an @mention comment into the conversation's session, if the mention trigger is enabled. */
async function routeMention(
	ctx: WorkflowContext,
	comment: {
		repo: string;
		number: number;
		body: string;
		authorLogin: string;
		authorType: string;
		commentId: number;
		subject: "issue_comment" | "pull_request_review_comment";
		isPullRequest: boolean;
	},
): Promise<void> {
	const { botLogin, triggers } = await ctx.integration(github).getSettings();
	if (!triggers.includes("mention")) return;
	if (isIgnoredInboundComment(comment.body, comment.authorLogin, comment.authorType, botLogin)) return;
	const mention = extractMention(comment.body, botLogin);
	if (!mention) return;

	// Acknowledge on sight: drop an eyes reaction on the comment that summoned us. Non-fatal —
	// a reaction failure must never stop the review from running.
	try {
		await ctx.integration(github).addReaction({
			repo: comment.repo,
			subject: comment.subject,
			commentId: comment.commentId,
			content: "eyes",
		});
	} catch (err) {
		console.error("[github] could not add reaction:", err instanceof Error ? err.message : err);
	}

	const tag = { "github:thread": `${comment.repo}#${comment.number}` };
	const [match] = await ctx.agent.findSessions(tag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({ setup: (s) => s.appendTags(tag) });

	// On a PR, check the code out for the agent; on a plain issue, the comment text is the whole ask.
	const text = mention.message || comment.body;
	if (comment.isPullRequest) {
		const { message, headSha } = await buildReviewTurn(ctx, comment.repo, comment.number, text);
		// Record the head SHA so the github_review tool can anchor inline comments to this commit.
		session.setTags({ "github:head-sha": headSha });
		await session.sendUserMessage(message, { deliverAs: "followUp" });
	} else {
		// followUp queues behind a running turn instead of interrupting it.
		await session.sendUserMessage(text, { deliverAs: "followUp" });
	}
}

// evt is typed from the event schema
export const inboundIssueComment = github.on("issue_comment", async (evt, ctx) => {
	await routeMention(ctx, {
		repo: evt.repo,
		number: evt.issueNumber,
		body: evt.body,
		authorLogin: evt.authorLogin,
		authorType: evt.authorType,
		commentId: evt.commentId,
		subject: "issue_comment",
		isPullRequest: evt.isPullRequest,
	});
});

export const inboundReviewComment = github.on("pull_request_review_comment", async (evt, ctx) => {
	await routeMention(ctx, {
		repo: evt.repo,
		number: evt.pullRequestNumber,
		body: evt.body,
		authorLogin: evt.authorLogin,
		authorType: evt.authorType,
		commentId: evt.commentId,
		subject: "pull_request_review_comment",
		isPullRequest: true,
	});
});

export const auto = github.on("pull_request", async (evt, ctx) => {
	const { triggers } = await ctx.integration(github).getSettings();
	if (!triggers.includes("auto")) return;
	if (evt.draft) return;
	if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(evt.action)) return;

	const tag = { "github:thread": `${evt.repo}#${evt.pullRequestNumber}` };
	const [match] = await ctx.agent.findSessions(tag);
	const session = match
		? await ctx.agent.openSession(match.id)
		: await ctx.agent.createSession({ setup: (s) => s.appendTags(tag) });

	// Dedupe on head SHA via a session tag: the same commits are reviewed once, even if the
	// transport re-emits the PR. Persist the marker before sending (at-most-once).
	if (session.getTags()["github:reviewed-sha"] === evt.headSha) return;
	session.setTags({ "github:reviewed-sha": evt.headSha });

	const { message, headSha } = await buildReviewTurn(
		ctx,
		evt.repo,
		evt.pullRequestNumber,
		"A pull request was opened or updated for review.",
	);
	// Record the head SHA so the github_review tool can anchor inline comments to this commit.
	session.setTags({ "github:head-sha": headSha });
	await session.sendUserMessage(message, { deliverAs: "followUp" });
});

export const reply = wolli.on("agent_end", async (evt, ctx) => {
	const tags = ctx.session.getTags();
	const thread = tags["github:thread"];
	if (!thread) return; // not a github-bound session
	// The github_review tool posts a formal review and sets this flag; when it did, stand down so the
	// summary is not also posted as a duplicate timeline comment. Clear it for the next turn.
	if (tags["github:review-posted"] === "1") {
		ctx.session.setTags({ "github:review-posted": "" });
		return;
	}
	const { repo, number } = parseThreadTag(thread);

	const text = evt.messages
		.filter((m) => m.role === "assistant")
		.at(-1)
		?.content.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!text) return; // a pure tool-call turn sends nothing

	// The marker rides the last chunk; combined with the bot-login check it prevents reply loops.
	for (const body of chunkComment(`${text}\n\n${GITHUB_COMMENT_MARKER}`)) {
		await ctx.integration(github).postComment({ repo, issueNumber: number, body });
	}
});
