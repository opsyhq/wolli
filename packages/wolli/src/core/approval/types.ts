/** Types a gated environment uses to get human approval before running on an unconfined target. */

/** One escalation the gate is asked to approve. */
export interface ApprovalRequest {
	target: string;
	command: string;
	cwd: string;
}

/** The gate's verdict: run (once or remembered) or refuse with a reason. */
export type ApprovalDecision = { allowed: true; scope: "once" | "always" } | { allowed: false; reason: string };

/** Decide whether one escalation may run. Fail-closed on no UI response. */
export type ApprovalGate = (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
