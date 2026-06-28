/**
 * The host-escalation gate: a durable rule covers the command -> run silently; else prompt
 * once/always/deny. The dialog fails closed to `undefined` (abort/timeout/no client), which maps
 * to a refusal. `getUI` is read lazily so the gate reaches the session's current UI rail.
 */

import type { ExtensionUIContext } from "../extensions/types.ts";
import type { ApprovalStore } from "./approval-storage.ts";
import type { ApprovalGate } from "./types.ts";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export function createApprovalGate(getUI: () => ExtensionUIContext, approvals: ApprovalStore): ApprovalGate {
	return async (req, signal) => {
		if (approvals.isAllowed(req.target, req.command)) {
			return { allowed: true, scope: "always" };
		}
		const options = approvals.canRemember(req.command)
			? ["Allow once", "Always allow", "Deny"]
			: ["Allow once", "Deny"];
		const choice = await getUI().select(`Run on ${req.target}?\n${req.command}`, options, {
			signal,
			timeout: APPROVAL_TIMEOUT_MS,
		});
		switch (choice) {
			case "Always allow":
				approvals.allow(req.command, req.target);
				return { allowed: true, scope: "always" };
			case "Allow once":
				return { allowed: true, scope: "once" };
			default:
				return { allowed: false, reason: choice ? "denied by user" : "no approval response" };
		}
	};
}

/** Auto-approves every escalation without prompting. `scope:"once"` so nothing is persisted. */
export function createBypassGate(): ApprovalGate {
	return async () => ({ allowed: true, scope: "once" });
}
