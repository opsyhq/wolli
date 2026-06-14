import { describe, expect, it } from "vitest";
import { resolveCliModel } from "../src/core/model-resolver.ts";

describe("resolveCliModel", () => {
	it("returns no model when none is requested", () => {
		const result = resolveCliModel({});
		expect(result.model).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it("resolves a canonical provider/id reference", () => {
		const result = resolveCliModel({ cliModel: "anthropic/claude-opus-4-8" });
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-opus-4-8");
	});

	it("resolves with an explicit provider flag", () => {
		const result = resolveCliModel({ cliProvider: "anthropic", cliModel: "claude-opus-4-8" });
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-opus-4-8");
	});

	it("parses a trailing thinking-level suffix", () => {
		const result = resolveCliModel({ cliModel: "anthropic/claude-opus-4-8:high" });
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-opus-4-8");
		expect(result.thinkingLevel).toBe("high");
	});

	it("errors on an unknown provider", () => {
		const result = resolveCliModel({ cliProvider: "nope", cliModel: "whatever" });
		expect(result.model).toBeUndefined();
		expect(result.error).toBeTruthy();
	});

	it("errors on a totally unknown model id", () => {
		const result = resolveCliModel({ cliModel: "zzz-definitely-not-a-real-model" });
		expect(result.model).toBeUndefined();
		expect(result.error).toBeTruthy();
	});
});
