/**
 * defineIntegration unit check: the authoring surface alone — no loader, no runner.
 *
 * `defineIntegration` mints inert data, so the runtime half asserts the definition shape:
 * one descriptor per authored event with the empty pre-load `service`, the raw authored
 * config riding `.config` unchanged, and no phantom fields materializing. The rest is
 * compile-time — `pnpm typecheck` includes test files, so the
 * `expectTypeOf`/`@ts-expect-error` lines are gated: event payload typing from the
 * schema, the typed producer ctx (`account`/`emit`), and the `ctx.integration` seam
 * (a definition in, the `IntegrationHandleOf` action handle out).
 */

import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	defineIntegration,
	type IntegrationEventDescriptor,
	type IntegrationEventPayload,
} from "../src/core/integrations/index.ts";
import type { WorkflowContext } from "../src/core/workflows/index.ts";

/** The docs' telegram surface: a `message` event and a `sendMessage` action. */
const telegram = defineIntegration({
	account: Type.Object({ botToken: Type.String() }),
	events: {
		message: Type.Object({ chatId: Type.Number(), text: Type.String() }),
	},
	actions: {
		sendMessage: {
			description: "Send a text message to a chat.",
			parameters: Type.Object({ chatId: Type.Number(), text: Type.String() }),
			execute: async () => ({ ok: true }),
		},
	},
	run(ctx) {
		// The definer-side view narrows account and emit from the authored schemas.
		expectTypeOf(ctx.account.botToken).toEqualTypeOf<string>();
		expectTypeOf(ctx.emit).toBeCallableWith("message", { chatId: 1, text: "hi" });
		// @ts-expect-error only authored event names are emittable
		ctx.emit("nope", {});
		// @ts-expect-error the payload must match the event schema
		ctx.emit("message", { chatId: "1" });
	},
});

describe("defineIntegration", () => {
	it("mints one descriptor per event, service empty until the loader stamps it", () => {
		expect(telegram.kind).toBe("integration");
		expect(telegram.service).toBe("");
		expect(telegram.events.message).toMatchObject({ kind: "integration", service: "", event: "message" });
		expect(telegram.events.message.schema).toBe(telegram.config.events?.message);
	});

	it("carries the raw authored config on .config for the runner to register from", () => {
		expect(telegram.config.actions?.sendMessage.description).toBe("Send a text message to a chat.");
		expect(telegram.config.actions?.sendMessage.parameters).toBeDefined();
		expect(typeof telegram.config.run).toBe("function");
	});

	it("materializes no phantom fields at runtime", () => {
		expect("_actions" in telegram).toBe(false);
		expect("_payload" in telegram.events.message).toBe(false);
	});

	it("yields an empty events map for an events-less definition", () => {
		const minimal = defineIntegration({
			actions: {
				ping: { parameters: Type.Object({}), execute: async () => ({ ok: true }) },
			},
		});
		expect(minimal.events).toEqual({});
		expect(minimal.service).toBe("");
	});

	it("types the event payload from the schema", () => {
		expectTypeOf(telegram.events.message).toEqualTypeOf<
			IntegrationEventDescriptor<{ chatId: number; text: string }>
		>();
		expectTypeOf<IntegrationEventPayload<typeof telegram.events.message>>().toEqualTypeOf<{
			chatId: number;
			text: string;
		}>();
	});

	it("resolves through ctx.integration to the typed action handle", () => {
		// The definition is the IntegrationKey; the handle's parameter type comes from the
		// action's `parameters` schema and its return type from the inferred `execute`.
		const resolveHandle = (ctx: WorkflowContext) => ctx.integration(telegram);
		expectTypeOf<ReturnType<typeof resolveHandle>>().toEqualTypeOf<{
			sendMessage: (params: { chatId: number; text: string }) => Promise<{ ok: boolean }>;
		}>();
		const misuse = (ctx: WorkflowContext) => {
			// @ts-expect-error a wrong param key is rejected at the call site
			return ctx.integration(telegram).sendMessage({ chatId: 1, body: "hi" });
		};
		void misuse;
	});
});
