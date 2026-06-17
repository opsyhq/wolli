/**
 * Offline wiring/validation check for the Telegram integration example.
 *
 * Loads the real `examples/integrations/telegram/index.ts` factory, builds an
 * IntegrationRunner over an in-memory account store, and asserts the parts that
 * don't require the network:
 *
 *  1. a handle resolves for a configured account and throws for an unconfigured one;
 *  2. each action rejects malformed params at the validation boundary (before
 *     `execute` runs, so no grammY call is ever made);
 *  3. the `message` event schema accepts the exact payload `run()` emits and rejects
 *     a malformed one.
 *
 * The long-poll producer (`run()`) and live Telegram API are intentionally not
 * exercised — those need a real token and network.
 */

import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import telegram from "../examples/integrations/telegram/index.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import {
	createIntegrationRuntime,
	type IntegrationConfig,
	IntegrationRunner,
	loadIntegrationFromFactory,
} from "../src/core/integrations/index.ts";

async function buildRunner() {
	const runtime = createIntegrationRuntime();
	const integration = await loadIntegrationFromFactory(telegram, process.cwd(), runtime, "<telegram>");
	const accounts = IntegrationAccountStorage.inMemory({
		telegram: { default: { botToken: "test" } },
	});
	const runner = new IntegrationRunner([integration], runtime, process.cwd(), accounts);
	runner.bindCore();
	return { runner, integration };
}

describe("telegram integration", () => {
	it("resolves a handle for a configured account and throws otherwise", async () => {
		const { runner } = await buildRunner();

		expect(() => runner.getIntegration("telegram", "default")).not.toThrow();
		expect(() => runner.getIntegration("telegram", "missing")).toThrow(/not configured/);
	});

	it("rejects malformed action params before any network call", async () => {
		const { runner } = await buildRunner();
		const tg = runner.getIntegration("telegram", "default");

		// sendMessage: chatId must be a number, text is required.
		await expect(tg.call("sendMessage", { chatId: "nope", text: "hi" })).rejects.toThrow(/invalid params/);
		await expect(tg.call("sendMessage", { chatId: 1 })).rejects.toThrow(/invalid params/);

		// sendChatAction: action is required.
		await expect(tg.call("sendChatAction", { chatId: 1 })).rejects.toThrow(/invalid params/);

		// setCommands: each command needs both command and description.
		await expect(tg.call("setCommands", { commands: [{ command: "new" }] })).rejects.toThrow(/invalid params/);

		// Unknown action name.
		await expect(tg.call("bogus", {})).rejects.toThrow(/unknown action/);
	});

	it("validates the message event payload against its schema", async () => {
		const { integration } = await buildRunner();
		const config = integration.definitions.get("telegram") as IntegrationConfig;
		const schema = config.events?.message;
		expect(schema).toBeDefined();
		const validate = Compile(schema!);

		// The exact shape run() emits.
		const valid = {
			chatId: 123456789,
			messageId: 42,
			text: "hello",
			from: { id: 555, username: "alice", firstName: "Alice" },
			chatType: "private",
			date: 1700000000,
		};
		expect(validate.Check(valid)).toBe(true);

		// from.username/firstName are optional — omitting them still validates.
		expect(validate.Check({ ...valid, from: { id: 555 } })).toBe(true);

		// Malformed: text must be a string, from is required.
		expect(validate.Check({ ...valid, text: 5 })).toBe(false);
		const { from: _omit, ...withoutFrom } = valid;
		expect(validate.Check(withoutFrom)).toBe(false);
	});
});
