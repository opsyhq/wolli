/**
 * Session tags + tag-driven session lookup.
 *
 *  1. fold:  successive `appendTags` writes merge into one map (later write wins per key);
 *  2. query: `AgentRuntime.findSessions(filter)` returns only the subset-matching session,
 *            with its folded `tags` populated.
 *
 * Both run against REAL on-disk sessions in a temp agent home (the `SessionManager`
 * read surface is a file snapshot, so the engine must actually flush each write).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/core/agent-runtime.ts";
import { AgentSettingsManager } from "../src/core/agent-settings-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import { IntegrationStore } from "../src/core/integration-store.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { openAgentSession } from "../src/core/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const AGENT = "scribe";

let home: string;
let sharedDir: string;
const registrations: Array<{ unregister(): void }> = [];

function makeRuntime(): AgentRuntime {
	const registration = registerFauxProvider();
	registrations.push(registration);
	// Faux models are typed Model<string>; the runtime wants Model<Api> (a string supertype).
	const model = registration.getModel() as unknown as Model<Api>;
	const authStorage = AuthStorage.create(join(sharedDir, "auth.json"));
	authStorage.setRuntimeApiKey(model.provider, "faux-test-key");
	return new AgentRuntime({
		name: AGENT,
		model,
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage),
		integrationAccounts: IntegrationAccountStorage.inMemory(),
		integrationStore: IntegrationStore.inMemory(),
	});
}

/** Create a brand-new stored session and wrap it in a SessionManager. */
async function newSessionManager(): Promise<SessionManager> {
	const { session } = await openAgentSession(AGENT, { fresh: true });
	return new SessionManager(session, await session.getMetadata());
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "wolli-tags-home-"));
	sharedDir = mkdtempSync(join(tmpdir(), "wolli-tags-shared-"));
	process.env.WOLLI_HOME = home;
	process.env.WOLLI_SHARED_DIR = sharedDir;
	AgentSettingsManager.createAgent({ name: AGENT });
});

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
	delete process.env.WOLLI_HOME;
	delete process.env.WOLLI_SHARED_DIR;
	rmSync(home, { recursive: true, force: true });
	rmSync(sharedDir, { recursive: true, force: true });
});

describe("session tags", () => {
	it("folds successive tags writes into one merged map", async () => {
		const sessionManager = await newSessionManager();
		expect(sessionManager.getTags()).toEqual({});

		await sessionManager.appendTags({ a: "1" });
		await sessionManager.appendTags({ b: "2" });
		expect(sessionManager.getTags()).toEqual({ a: "1", b: "2" });

		// A later write wins for a key it shares; untouched keys survive.
		await sessionManager.appendTags({ a: "3" });
		expect(sessionManager.getTags()).toEqual({ a: "3", b: "2" });
	});

	it("findSessions returns only the subset-matching session, with tags populated", async () => {
		const tagged = await newSessionManager();
		await tagged.appendTags({ "telegram:chat": "1" });
		const other = await newSessionManager();
		await other.appendTags({ "telegram:chat": "2" });

		const runtime = makeRuntime();
		const matches = await runtime.findSessions({ "telegram:chat": "1" });

		expect(matches).toHaveLength(1);
		expect(matches[0].id).toBe(tagged.getSessionId());
		expect(matches[0].tags).toEqual({ "telegram:chat": "1" });
		await runtime.cleanup();
	});
});
