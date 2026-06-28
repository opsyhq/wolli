// The gate: tier-1 silent path, once/always/deny mapping, hidden "Always allow" for
// non-rememberable commands, and the fail-closed default when the dialog returns nothing.

import { describe, expect, it } from "vitest";
import { createApprovalGate, createBypassGate } from "../src/core/approval/approval-gate.ts";
import { ApprovalStore } from "../src/core/approval/approval-storage.ts";
import type { ApprovalRequest } from "../src/core/approval/types.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";

interface FakeUI {
	ui: ExtensionUIContext;
	lastOptions: string[] | undefined;
}

/** A UI whose `select` always returns `choice` and records the options it was shown. */
function fakeUI(choice: string | undefined): FakeUI {
	const state: FakeUI = { ui: undefined as unknown as ExtensionUIContext, lastOptions: undefined };
	state.ui = {
		select: async (_title: string, options: string[]) => {
			state.lastOptions = options;
			return choice;
		},
	} as unknown as ExtensionUIContext;
	return state;
}

const req = (command: string): ApprovalRequest => ({ target: "host", command, cwd: "/tmp" });

describe("createApprovalGate", () => {
	it("resolves silently when a durable rule already covers the command", async () => {
		const approvals = ApprovalStore.inMemory();
		approvals.allow("git push origin main", "host");
		const ui = fakeUI("Deny"); // would deny if asked
		const gate = createApprovalGate(() => ui.ui, approvals);

		expect(await gate(req("git push origin main"))).toEqual({ allowed: true, scope: "always" });
		expect(ui.lastOptions).toBeUndefined(); // never prompted
	});

	it("maps 'Allow once' to a one-shot grant without persisting", async () => {
		const approvals = ApprovalStore.inMemory();
		const gate = createApprovalGate(() => fakeUI("Allow once").ui, approvals);

		expect(await gate(req("npm run deploy"))).toEqual({ allowed: true, scope: "once" });
		expect(approvals.isAllowed("host", "npm run deploy")).toBe(false);
	});

	it("maps 'Always allow' to a persisted rule", async () => {
		const approvals = ApprovalStore.inMemory();
		const gate = createApprovalGate(() => fakeUI("Always allow").ui, approvals);

		expect(await gate(req("git push origin main"))).toEqual({ allowed: true, scope: "always" });
		expect(approvals.isAllowed("host", "git push origin feature")).toBe(true);
	});

	it("maps 'Deny' to a refusal", async () => {
		const gate = createApprovalGate(() => fakeUI("Deny").ui, ApprovalStore.inMemory());
		expect(await gate(req("rm -rf /"))).toEqual({ allowed: false, reason: "denied by user" });
	});

	it("fails closed when the dialog returns nothing", async () => {
		const gate = createApprovalGate(() => fakeUI(undefined).ui, ApprovalStore.inMemory());
		expect(await gate(req("git push origin main"))).toEqual({
			allowed: false,
			reason: "no approval response",
		});
	});

	it("hides 'Always allow' for non-rememberable commands", async () => {
		const ui = fakeUI("Allow once");
		const gate = createApprovalGate(() => ui.ui, ApprovalStore.inMemory());

		await gate(req("bash -c 'echo hi'"));
		expect(ui.lastOptions).toEqual(["Allow once", "Deny"]);
	});
});

describe("createBypassGate", () => {
	it("auto-approves any request as a one-shot grant", async () => {
		const gate = createBypassGate();
		expect(await gate(req("rm -rf /"))).toEqual({ allowed: true, scope: "once" });
	});
});
