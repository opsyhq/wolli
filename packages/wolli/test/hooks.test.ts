/**
 * Hook unit check: the defineHook authoring surface.
 *
 * `defineHook` is identity at runtime, so the value is (a) that identity, and (b)
 * compile-time assertions that the `before:` literal narrows the handler's event and
 * result shapes and that ctx is the lifecycle workflow ctx (every hook event is
 * session-scoped) — `pnpm typecheck` includes test files, so the
 * `expectTypeOf`/`@ts-expect-error` lines are gated.
 *
 * The documented-surface suite pins the `before:` set at exactly the eight documented
 * literals, mirroring the AgentEventMap pin in workflows.test.ts.
 */

import type { AgentMessage } from "@opsyhq/agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	defineHook,
	type HookDefinition,
	type HookEventMap,
	type HookResultMap,
	type LifecycleWorkflowContext,
	type WorkflowSession,
} from "../src/core/workflows/index.ts";

describe("defineHook", () => {
	it("is identity at runtime", () => {
		const definition: HookDefinition<"tool_call"> = {
			before: "tool_call",
			run() {},
		};
		expect(defineHook(definition)).toBe(definition);
	});

	it("types a tool_call hook: the handler sees the tool-call event and can block", () => {
		const hook = defineHook({
			before: "tool_call",
			async run(evt, ctx) {
				expectTypeOf(evt.type).toEqualTypeOf<"tool_call">();
				expectTypeOf(evt.toolName).toEqualTypeOf<string>();
				expectTypeOf(ctx).toEqualTypeOf<LifecycleWorkflowContext>();
				expectTypeOf(ctx.session).toEqualTypeOf<WorkflowSession>();
				if (evt.toolName === "bash" && JSON.stringify(evt.input).includes("rm -rf")) {
					return { block: true, reason: "not allowed" };
				}
			},
		});

		expect(hook.before).toBe("tool_call");
	});

	it("types a message_end hook: the handler can replace the finalized message", () => {
		const hook = defineHook({
			before: "message_end",
			async run(evt) {
				expectTypeOf(evt.type).toEqualTypeOf<"message_end">();
				expectTypeOf(evt.message).toEqualTypeOf<AgentMessage>();
				return { message: evt.message };
			},
		});

		expect(hook.before).toBe("message_end");
	});

	it("accepts a handler that returns nothing: no interception", () => {
		const hook = defineHook({
			before: "input",
			run(evt) {
				expectTypeOf(evt.text).toEqualTypeOf<string>();
			},
		});

		expect(hook.before).toBe("input");
	});

	it("rejects observe-only lifecycle events: hooks bind before:, not on:", () => {
		defineHook({
			// @ts-expect-error "turn_end" is observe-only lifecycle surface, not one of the eight before: events
			before: "turn_end",
			run() {},
		});
	});
});

describe("documented surface", () => {
	it("pins the before: event set: a key added or renamed on either side fails typecheck", () => {
		expectTypeOf<keyof HookEventMap>().toEqualTypeOf<
			| "tool_call"
			| "tool_result"
			| "input"
			| "context"
			| "provider_request"
			| "agent_start"
			| "compact"
			| "message_end"
		>();
		expectTypeOf<keyof HookResultMap>().toEqualTypeOf<keyof HookEventMap>();
	});
});
