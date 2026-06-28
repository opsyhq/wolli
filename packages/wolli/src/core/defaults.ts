import type { ThinkingLevel } from "@opsyhq/agent";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Default model when an agent has none configured and no shared default is set. */
export const DEFAULT_MODEL = "openai/gpt-5.5";

/** The valid thinking-level tokens, used to recognize a `model:thinking` pattern suffix. */
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return THINKING_LEVELS.includes(level as ThinkingLevel);
}
