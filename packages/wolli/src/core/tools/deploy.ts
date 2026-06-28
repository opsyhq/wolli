/**
 * The `deploy` tool — the agent's way of declaring it's ready to be deployed.
 *
 * Net-new for wolli.
 *
 * The tool authors the agent's identity — it distills and writes its own
 * `purpose` (into agent.json) and its final SOUL.md. We trust the agent to know
 * its purpose; the human's chatter during forming is raw material, not the
 * canonical purpose. The tool does NOT stamp `deployedAt`: the human-held latch
 * is flipped by the UI after a y/n confirmation (see InteractiveMode), so a
 * written-but-unconfirmed SOUL/purpose leaves the agent still forming.
 */

import type { AgentTool, AgentToolResult } from "@opsyhq/agent";
import { Type } from "typebox";
import { getSoulPath } from "../../config.ts";
import { AgentSettingsManager } from "../agent-settings-manager.ts";
import { SOUL_BUDGET, writeMemoryFile } from "../memory.ts";

const deploySchema = Type.Object({
	purpose: Type.String({
		description:
			"Your purpose — one tight line distilling what you're for. You decide it; your human's chatter is raw material, not the wording. Written to agent.json.",
	}),
	soul: Type.String({
		description:
			"Your final SOUL.md — who you are, what you're for, and how you operate. Written verbatim to SOUL.md.",
	}),
});

export interface DeployToolDetails {
	applied: boolean;
	bytes?: number;
}

function textResult(text: string, details: DeployToolDetails): AgentToolResult<DeployToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export function createDeployTool(name: string): AgentTool<typeof deploySchema, DeployToolDetails> {
	return {
		name: "deploy",
		label: "Deploy",
		description:
			"Declare you're ready to be deployed. Call this with your distilled purpose and final SOUL.md once you " +
			"understand what you're for. It records your purpose, writes SOUL.md, and asks your human to confirm — it " +
			"does not deploy you on its own. Only available while you're still forming.",
		parameters: deploySchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const purpose = params.purpose.trim();
			const soul = params.soul.trim();
			if (!purpose) {
				return textResult("purpose is required — pass a one-line purpose as the `purpose` argument.", {
					applied: false,
				});
			}
			if (!soul) {
				return textResult("soul is required — pass your full SOUL.md as the `soul` argument.", { applied: false });
			}
			if (soul.length > SOUL_BUDGET) {
				return textResult(
					`Not saved: SOUL.md would be ${soul.length} chars, over the ${SOUL_BUDGET} budget. Tighten it first.`,
					{ applied: false },
				);
			}

			AgentSettingsManager.create(name).setAgentPurpose(purpose);
			writeMemoryFile(getSoulPath(name), soul);
			return textResult("Purpose and SOUL.md saved — awaiting your human's confirmation to deploy.", {
				applied: true,
				bytes: soul.length,
			});
		},
	};
}
