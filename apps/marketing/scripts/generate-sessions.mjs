// Generates the demo rail's session JSONL files. Run with:
//   node generate-sessions.mjs <output-dir>
// Built as a script so JSON escaping and "wrote N bytes" counts stay exact.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: node generate-sessions.mjs <output-dir>");

const MODEL = {
	api: "anthropic",
	provider: "anthropic",
	model: "claude-opus-4-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

function bytes(content) {
	return Buffer.byteLength(content, "utf-8");
}

// One session builder: chains parentId, stamps entry + message timestamps.
function session({ id, start, cwd, prefix }) {
	const startMs = Date.parse(start);
	const entries = [];
	let parentId = null;
	let n = 0;

	const push = (message, offsetSec) => {
		const entryId = `${prefix}${n++}`;
		entries.push({
			type: "message",
			id: entryId,
			parentId,
			timestamp: start,
			message: { ...message, timestamp: startMs + offsetSec * 1000 },
		});
		parentId = entryId;
	};

	return {
		user(text, offsetSec) {
			push({ role: "user", content: [{ type: "text", text }] }, offsetSec);
		},
		assistant(content, offsetSec, stopReason = "stop") {
			push({ role: "assistant", content, ...MODEL, stopReason }, offsetSec);
		},
		toolResult(toolCallId, toolName, text, offsetSec, isError = false) {
			push({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError }, offsetSec);
		},
		write(path) {
			const header = { type: "session", version: 3, id, timestamp: start, cwd };
			const lines = [header, ...entries].map((line) => JSON.stringify(line));
			writeFileSync(path, `${lines.join("\n")}\n`);
			console.log(`${path}: ${entries.length} messages`);
		},
		count() {
			return entries.length;
		},
	};
}

const CWD = "~/.wolli/agents/scout";

// ---------------------------------------------------------------------------
// Written file contents
// ---------------------------------------------------------------------------

const SOUL = `# SOUL

I am scout. I watch this team's GitHub issues.

When an issue opens I look at it right away and flag what is
urgent: security reports, or anything from a paying customer.
Everything else I leave alone.

I keep my reports short, concrete, and honest about severity.
`;

const INTEGRATION = `import { defineIntegration } from "wolli";
import { Type } from "typebox";

export default defineIntegration({
  name: "github",
  account: Type.Object({ token: Type.String(), repo: Type.String() }),
  events: {
    issue_opened: Type.Object({
      number: Type.Number(),
      title: Type.String(),
      author: Type.String(),
      body: Type.String(),
    }),
  },
  actions: {
    latest: {
      description: "Fetch the most recently opened issue.",
      parameters: Type.Object({}),
      execute: (_params, ctx) => api(ctx.account, "issues?per_page=1"),
    },
    addLabels: {
      description: "Add labels to an issue.",
      parameters: Type.Object({ number: Type.Number(), labels: Type.Array(Type.String()) }),
      execute: (params, ctx) => api(ctx.account, \`issues/\${params.number}/labels\`, params),
    },
    comment: {
      description: "Comment on an issue.",
      parameters: Type.Object({ number: Type.Number(), body: Type.String() }),
      execute: (params, ctx) => api(ctx.account, \`issues/\${params.number}/comments\`, params),
    },
  },
  run(ctx) {
    // Poll for issues opened since the last one seen; emit one event each.
    const timer = setInterval(() => pollNewIssues(ctx), 60_000);
    const dispose = () => clearInterval(timer);
    ctx.signal.addEventListener("abort", dispose);
    return dispose;
  },
});
`;

const WORKFLOW = `import { defineWorkflow } from "wolli";

export default defineWorkflow({
  name: "on-issue-opened",
  on: { integration: "github", event: "issue_opened" },
  async run(ctx, issue) {
    // Wake me in a fresh session with everything I need to triage.
    await ctx.agent.sendUserMessage(
      \`[github] Issue #\${issue.number} opened by @\${issue.author}: \${issue.title}\\n\\n\${issue.body}\`,
    );
  },
});
`;

const TOOL = `import { defineTool } from "wolli";
import { Type } from "typebox";

export default defineTool({
  name: "github",
  description: "Act on the repo's issues: fetch the latest, add labels, or comment.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("latest"), Type.Literal("addLabels"), Type.Literal("comment")]),
    number: Type.Optional(Type.Number()),
    labels: Type.Optional(Type.Array(Type.String())),
    body: Type.Optional(Type.String()),
  }),
  async execute(params, ctx) {
    const github = ctx.integrations.get("github");
    return github.call(params.action, params);
  },
});
`;

const MEMORY = `# MEMORY

- @mira-holt is on the Scale plan. Her issues are urgent by default.
- Debug mode once leaked auth tokens into request logs (#912).
  Treat anything touching logging as a likely security issue.
`;

const SKILL = `---
name: issue-triage
description: Triage a newly opened GitHub issue and flag urgent ones.
---

When an issue opens:

1. Read the title and body. Security reports are always urgent:
   leaks, auth bypasses, anything touching tokens or logging.
2. Check the author against MEMORY.md. Paying customers are urgent.
3. Urgent: label it \`urgent\` (plus \`security\` when it applies) and
   message the team with one honest paragraph right away.
4. Not urgent: leave it alone. No labels, no noise.
`;

// ---------------------------------------------------------------------------
// forming.jsonl + extending.jsonl (one session, two points in time)
// ---------------------------------------------------------------------------

function formingTurns(s) {
	s.assistant([{ type: "text", text: "What is my purpose?" }], 0);
	s.user(
		"You watch our GitHub issues. As they open, flag anything urgent: security reports, or anything from a paying customer.",
		18,
	);
	s.assistant(
		[
			{
				type: "text",
				text: "Got it. I'm writing who I am into my SOUL.md so it survives past this conversation.",
			},
			{ type: "toolCall", id: "call_soul_1", name: "write", arguments: { path: "SOUL.md", content: SOUL } },
		],
		22,
		"toolUse",
	);
	s.toolResult("call_soul_1", "write", `Successfully wrote ${bytes(SOUL)} bytes to SOUL.md`, 23);
	s.assistant(
		[
			{
				type: "text",
				text: "Done. I know what I'm for. One gap: nothing delivers issues to me yet. I can write a GitHub integration and a workflow that wakes me the moment an issue opens. Want me to build that?",
			},
		],
		26,
	);
}

const forming = session({ id: "demo-scout-0001", start: "2026-06-21T09:00:00.000Z", cwd: CWD, prefix: "f" });
formingTurns(forming);
forming.write(join(outDir, "forming.jsonl"));

const extending = session({ id: "demo-scout-0001", start: "2026-06-21T09:00:00.000Z", cwd: CWD, prefix: "f" });
formingTurns(extending);
console.log(`extending startAfter = ${extending.count()}`);
extending.user("yes, go ahead", 71);
extending.assistant(
	[
		{
			type: "text",
			text: "Three pieces. First the integration: it holds the token, polls the repo, and turns new issues into events.",
		},
		{
			type: "toolCall",
			id: "call_gh_1",
			name: "write",
			arguments: { path: "integrations/github.ts", content: INTEGRATION },
		},
	],
	78,
	"toolUse",
);
extending.toolResult("call_gh_1", "write", `Successfully wrote ${bytes(INTEGRATION)} bytes to integrations/github.ts`, 80);
extending.assistant(
	[
		{
			type: "text",
			text: "Now the workflow. When the integration hears a new issue, it wakes me with the details.",
		},
		{
			type: "toolCall",
			id: "call_wf_1",
			name: "write",
			arguments: { path: "workflows/on-issue-opened.ts", content: WORKFLOW },
		},
	],
	87,
	"toolUse",
);
extending.toolResult(
	"call_wf_1",
	"write",
	`Successfully wrote ${bytes(WORKFLOW)} bytes to workflows/on-issue-opened.ts`,
	89,
);
extending.assistant(
	[
		{
			type: "text",
			text: "And a tool so I can act back: fetch the latest issue, add labels, or comment.",
		},
		{ type: "toolCall", id: "call_tool_1", name: "write", arguments: { path: "tools/github.ts", content: TOOL } },
	],
	94,
	"toolUse",
);
extending.toolResult("call_tool_1", "write", `Successfully wrote ${bytes(TOOL)} bytes to tools/github.ts`, 96);
extending.assistant(
	[
		{
			type: "text",
			text: "All three in place. Proving the whole path: my new tool, through the integration, to the real repo:",
		},
		{ type: "toolCall", id: "call_test_1", name: "github", arguments: { action: "latest" } },
	],
	101,
	"toolUse",
);
extending.toolResult(
	"call_test_1",
	"github",
	'acme/api#908 "Rate limit headers missing on 304 responses", opened by @pvarga, state: open',
	103,
);
extending.assistant(
	[
		{
			type: "text",
			text: "There it is: tool, through integration, to repo and back. The integration polls once a minute and the workflow wakes me for every new issue. You don't need to do anything; the next issue that opens, I'm on it.",
		},
	],
	108,
);
extending.write(join(outDir, "extending.jsonl"));

// ---------------------------------------------------------------------------
// triggered.jsonl + skill.jsonl (one session woken by the workflow, two points in
// time: the urgent flag, then days later a quiet triage that becomes a skill)
// ---------------------------------------------------------------------------

function triggeredTurns(s) {
	s.user(
		`[github] Issue #912 opened by @mira-holt: Debug mode logs full session tokens

Enabling debug mode prints every request header to the worker logs, including Authorization bearer tokens. Our ops team just found production tokens sitting in our log aggregator. We're on the Scale plan and this is blocking our rollout.`,
		0,
	);
	s.assistant(
		[
			{
				type: "text",
				text: "A security report, from a Scale-plan customer: both of my urgency criteria at once. Flagging it now.",
			},
			{
				type: "toolCall",
				id: "call_flag_1",
				name: "github",
				arguments: { action: "addLabels", number: 912, labels: ["urgent", "security"] },
			},
		],
		6,
		"toolUse",
	);
	s.toolResult("call_flag_1", "github", "Added labels to acme/api#912: urgent, security", 8);
	s.assistant(
		[
			{ type: "text", text: "Two things here are worth keeping." },
			{ type: "toolCall", id: "call_mem_1", name: "write", arguments: { path: "MEMORY.md", content: MEMORY } },
		],
		13,
		"toolUse",
	);
	s.toolResult("call_mem_1", "write", `Successfully wrote ${bytes(MEMORY)} bytes to MEMORY.md`, 14);
	s.assistant(
		[
			{
				type: "text",
				text: "Flagged #912 as urgent: production auth tokens are leaking into logs when debug mode is on, reported by a Scale-plan customer whose rollout is blocked. This needs eyes today. I've labeled it urgent + security and noted the reporter so I recognize her next time.",
			},
		],
		18,
	);
}

const triggered = session({ id: "demo-scout-0002", start: "2026-06-23T14:07:00.000Z", cwd: CWD, prefix: "t" });
triggeredTurns(triggered);
triggered.write(join(outDir, "triggered.jsonl"));

// Three days later the workflow drops the next issue into the same session.
const DAYS_LATER = 3 * 86400;
const skill = session({ id: "demo-scout-0002", start: "2026-06-23T14:07:00.000Z", cwd: CWD, prefix: "t" });
triggeredTurns(skill);
skill.user(
	`[github] Issue #915 opened by @dozer99: Typo in quickstart: "enviroment"

The quickstart guide says "enviroment variables". One-letter fix, page src/docs/quickstart.md.`,
	DAYS_LATER,
);
skill.assistant(
	[
		{
			type: "text",
			text: "A docs typo from a free account: not urgent, so I stay quiet. But this is the fourth issue I've triaged the same way. The routine belongs in a skill, not in my head.",
		},
		{
			type: "toolCall",
			id: "call_skill_1",
			name: "write",
			arguments: { path: "skills/issue-triage/SKILL.md", content: SKILL },
		},
	],
	DAYS_LATER + 7,
	"toolUse",
);
skill.toolResult(
	"call_skill_1",
	"write",
	`Successfully wrote ${bytes(SKILL)} bytes to skills/issue-triage/SKILL.md`,
	DAYS_LATER + 9,
);
skill.assistant(
	[
		{
			type: "text",
			text: "Nothing urgent about #915, no flag, no noise. And triage is a skill now: every future wake-up loads it, instead of me re-deriving the rules each time.",
		},
	],
	DAYS_LATER + 13,
);
skill.write(join(outDir, "skill.jsonl"));
