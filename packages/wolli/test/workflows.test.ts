/**
 * Workflow-subsystem unit check: the authoring surface.
 *
 * `defineWorkflow` is identity at runtime, so the value here is (a) `getWorkflowKind`
 * over all three trigger shapes, and (b) compile-time assertions
 * that handler payloads and ctx are typed per trigger kind — `pnpm typecheck` includes
 * test files, so the `expectTypeOf`/`@ts-expect-error` lines are gated.
 */

import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	defineWorkflow,
	getWorkflowKind,
	type IntegrationEventDescriptor,
	type LifecycleWorkflowContext,
	type LifecycleWorkflowDefinition,
	type WorkflowContext,
	type WorkflowSession,
} from "../src/core/workflows/index.ts";

interface HeartbeatTick {
	seq: number;
	at: number;
}

/** Inline descriptor stand-in for what `defineIntegration` will mint in Phase 2. */
const tick: IntegrationEventDescriptor<HeartbeatTick> = {
	kind: "integration",
	service: "heartbeat",
	event: "tick",
};

describe("defineWorkflow", () => {
	it("is identity at runtime", () => {
		const definition: LifecycleWorkflowDefinition<"agent_start"> = {
			on: "agent_start",
			run() {},
		};
		expect(defineWorkflow(definition)).toBe(definition);
	});

	it("types an integration-event workflow from the descriptor and classifies it", () => {
		const workflow = defineWorkflow({
			on: tick,
			async run(msg, ctx) {
				expectTypeOf(msg).toEqualTypeOf<HeartbeatTick>();
				expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
				// @ts-expect-error integration-event runs have no producing session
				void ctx.session;
			},
		});

		expect(workflow.on).toBe(tick);
		expect(getWorkflowKind(workflow)).toBe("integration");
	});

	it("types a lifecycle workflow via AgentEventMap and classifies it", () => {
		const workflow = defineWorkflow({
			on: "turn_end",
			async run(evt, ctx) {
				expectTypeOf(evt.turnIndex).toEqualTypeOf<number>();
				expectTypeOf(evt.toolResults.length).toEqualTypeOf<number>();
				expectTypeOf(ctx).toEqualTypeOf<LifecycleWorkflowContext>();
				expectTypeOf(ctx.session).toEqualTypeOf<WorkflowSession>();
			},
		});

		expect(workflow.on).toBe("turn_end");
		expect(getWorkflowKind(workflow)).toBe("lifecycle");
	});

	it("types a callable workflow from its schemas and classifies it", () => {
		const workflow = defineWorkflow({
			input: Type.Object({ url: Type.String() }),
			output: Type.Object({ excerpt: Type.String() }),
			run(input, ctx) {
				expectTypeOf(input.url).toEqualTypeOf<string>();
				expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
				return { excerpt: input.url.slice(0, 8) };
			},
		});

		expect(getWorkflowKind(workflow)).toBe("callable");
	});
});
