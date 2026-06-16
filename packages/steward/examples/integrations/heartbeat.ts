/**
 * Heartbeat — the trivial reference integration.
 *
 * It exercises the whole integration surface end-to-end with no external service:
 *  - a producer `run(ctx)` that emits a `tick` event on a timer, and
 *  - a `ping` action that returns a request/response payload.
 *
 * The configured account record is `{ intervalMs? }` (see `account` schema); the
 * agent's `integrations.json` holds one record per account, e.g.
 * `{ "heartbeat": { "default": { "intervalMs": 1000 } } }`.
 */

import type { IntegrationsAPI } from "@opsyhq/steward";
import { Type } from "typebox";

const DEFAULT_INTERVAL_MS = 1000;

export default function (steward: IntegrationsAPI) {
	steward.registerIntegration({
		name: "heartbeat",
		account: Type.Object({
			intervalMs: Type.Optional(Type.Number()),
		}),
		events: {
			tick: Type.Object({
				seq: Type.Number(),
				at: Type.Number(),
			}),
		},
		actions: {
			ping: {
				description: "Liveness probe — returns the current time.",
				parameters: Type.Object({}),
				execute: async () => ({ ok: true, at: Date.now() }),
			},
		},
		run(ctx) {
			const account = ctx.account as { intervalMs?: number };
			const intervalMs = account.intervalMs ?? DEFAULT_INTERVAL_MS;

			let seq = 0;
			const id = setInterval(() => {
				seq += 1;
				ctx.emit("tick", { seq, at: Date.now() });
			}, intervalMs);

			const dispose = () => clearInterval(id);
			// Belt and suspenders: stop on abort as well as via the returned disposer.
			ctx.signal.addEventListener("abort", dispose);
			return dispose;
		},
	});
}
