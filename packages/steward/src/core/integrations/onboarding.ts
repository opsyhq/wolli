/**
 * Integration onboarding — the persist/validate logic, decoupled from the TUI.
 *
 * `onboardIntegration` drives one integration's `onboard(ctx)`, persists the returned
 * record, and validates it by reusing the runner's `resolveAccount` path. It is
 * UI-agnostic (the `ui` it forwards is whatever the caller built), so it is unit-testable
 * with a stub UI surface + an in-memory account store. The paired extension (the mapping
 * half of a dual-half package) is resolved in place by the package manager — no copy. The
 * daemon drives this via `runDaemonOnboarding` (`modes/daemon/daemon-mode.ts`), forwarding the
 * agent's live account store and its wire-backed UI context.
 */

import type { IntegrationAccountRecord, IntegrationAccountStorage } from "../integration-account-storage.ts";
import { resolveConfigValueUncached } from "../resolve-config-value.ts";
import type { Integration, IntegrationOnboardUI } from "./types.ts";

export interface OnboardIntegrationParams {
	/** Service id to configure. */
	service: string;
	/** Loaded integrations to search for the service definition. */
	integrations: Integration[];
	/** Per-agent account store (the record is written here). */
	accounts: IntegrationAccountStorage;
	/** Narrowed dialog surface forwarded to `onboard(ctx)`. */
	ui: IntegrationOnboardUI;
	signal?: AbortSignal;
}

export type OnboardIntegrationResult =
	| { status: "connected" }
	| { status: "cancelled" }
	| { status: "not-found" }
	| { status: "no-onboard" }
	| { status: "error"; message: string };

/**
 * Run one integration's guided onboarding end to end. Returns a status (the caller
 * surfaces it to the user); only `onboard`-internal messages (e.g. a token check
 * failing) go through `ctx.ui` here.
 */
export async function onboardIntegration(params: OnboardIntegrationParams): Promise<OnboardIntegrationResult> {
	const { service, integrations, accounts, ui, signal } = params;

	const integration = integrations.find((i) => i.definitions.has(service));
	const config = integration?.definitions.get(service);
	if (!integration || !config) {
		return { status: "not-found" };
	}
	if (!config.onboard) {
		return { status: "no-onboard" };
	}

	let record: IntegrationAccountRecord | undefined;
	try {
		record = await config.onboard({
			ui,
			resolve: resolveConfigValueUncached,
			signal: signal ?? new AbortController().signal,
		});
	} catch (err) {
		return { status: "error", message: err instanceof Error ? err.message : String(err) };
	}
	if (!record) {
		return { status: "cancelled" };
	}

	// Validate by reusing the runner's path: set, then resolveAccount (resolves `$ENV`
	// and schema-checks). On failure, roll back the stored record.
	accounts.set(service, "default", record);
	try {
		accounts.resolveAccount(service, "default", config.account);
	} catch (err) {
		accounts.remove(service, "default");
		return { status: "error", message: err instanceof Error ? err.message : String(err) };
	}

	// The paired extension (the mapping half of a dual-half package) is resolved in place
	// by the package manager from the same install — nothing to copy.
	return { status: "connected" };
}
