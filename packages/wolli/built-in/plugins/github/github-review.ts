/**
 * GitHub review tool — lets the review agent post an actual pull-request review rather than a
 * plain comment: inline notes anchored to diff lines (`action: "comment"`) and a formal verdict
 * (`action: "submit"`). It drives the github integration's write actions, deriving the target PR
 * and head commit from the session's `github:thread` / `github:head-sha` tags (set when the review
 * turn is seeded), so the agent only supplies path/line/body.
 *
 * `submit` is capped to COMMENT / REQUEST_CHANGES — the reviewer never auto-approves. On submit it
 * sets `github:review-posted` so the `agent_end` reply workflow stands down and does not also post
 * the summary as a duplicate timeline comment.
 */

import { defineTool } from "wolli";
import { Type } from "typebox";
import { parseThreadTag } from "./github-api.ts";
import github from "./index.ts";

const ReviewParams = Type.Object({
	action: Type.Union([Type.Literal("comment"), Type.Literal("submit")], {
		description: "comment: leave an inline comment on a diff line. submit: submit the overall review verdict.",
	}),
	path: Type.Optional(Type.String({ description: "comment: file path, exactly as it appears in the PR." })),
	line: Type.Optional(
		Type.Number({ description: "comment: line number in the file to attach to. Must be a line this PR changed." }),
	),
	side: Type.Optional(
		Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")], {
			description: "comment: RIGHT (the new version, default) or LEFT (the old version).",
		}),
	),
	body: Type.Optional(Type.String({ description: "comment: the note. submit: the review summary (Markdown)." })),
	event: Type.Optional(
		Type.Union([Type.Literal("COMMENT"), Type.Literal("REQUEST_CHANGES")], {
			description: "submit: COMMENT for a non-blocking review, REQUEST_CHANGES to block the merge.",
		}),
	),
});

function text(message: string, details: unknown) {
	return { content: [{ type: "text" as const, text: message }], details };
}

export default defineTool({
	name: "github_review",
	label: "GitHub review",
	description:
		"Post a review on the pull request under review. action=comment leaves an inline comment on a specific file+line of the diff; action=submit submits the overall verdict (COMMENT or REQUEST_CHANGES) with a summary. The target PR is the current review session, so you only supply path/line/body — not the repo or PR number.",
	promptSnippet: "github_review: leave inline PR review comments and submit a verdict (COMMENT / REQUEST_CHANGES).",
	promptGuidelines: [
		"When reviewing a pull request, leave each finding as an inline github_review comment on the exact changed line, then finish with one github_review submit — REQUEST_CHANGES if there are real problems, otherwise COMMENT.",
	],
	parameters: ReviewParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const tags = ctx.session.getTags();
		const thread = tags["github:thread"];
		if (!thread) return text("Error: this is not a GitHub pull-request review session.", { error: "no thread" });

		let repo: string;
		let pullRequestNumber: number;
		try {
			({ repo, number: pullRequestNumber } = parseThreadTag(thread));
		} catch (err) {
			return text(`Error: ${err instanceof Error ? err.message : String(err)}`, { error: "bad thread tag" });
		}

		const gh = ctx.integration(github);
		try {
			if (params.action === "comment") {
				if (!params.path || params.line === undefined || !params.body) {
					return text("Error: path, line, and body are required for action=comment.", { error: "missing fields" });
				}
				const commitId = tags["github:head-sha"];
				if (!commitId) {
					return text("Error: the PR head commit is unknown, cannot anchor an inline comment.", { error: "no head sha" });
				}
				const result = await gh.createReviewComment({
					repo,
					pullRequestNumber,
					body: params.body,
					commitId,
					path: params.path,
					line: params.line,
					side: params.side,
				});
				return text(`Left an inline comment on ${params.path}:${params.line}.`, result);
			}

			// action === "submit"
			if (!params.event) {
				return text("Error: event (COMMENT or REQUEST_CHANGES) is required for action=submit.", { error: "missing event" });
			}
			const result = await gh.submitReview({ repo, pullRequestNumber, event: params.event, body: params.body });
			// Stand down the agent_end reply: the formal review is this turn's output, so it must not
			// also be posted as a duplicate timeline comment.
			ctx.session.setTags({ "github:review-posted": "1" });
			return text(`Submitted a ${params.event} review on ${repo}#${pullRequestNumber}.`, result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return text(`Error: ${message}`, { error: message });
		}
	},
});
