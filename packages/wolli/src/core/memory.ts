/**
 * Tier-1 curated memory: MEMORY.md (the agent's own notebook) and USER.md (facts
 * about the user). Net-new for wolli. Plain `readFileSync`/`writeFileSync` IO
 * and `load*`/`read*`/`write*` verbs.
 *
 * Frozen-snapshot rule: `loadMemory()` is read ONCE at session start and baked
 * into the system prompt. Mid-session writes (via the memory tool) land on disk
 * but only enter the prompt on the next session, keeping the prefix cache warm.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getMemoryPath, getSoulPath, getUserMemoryPath } from "../config.ts";

/** Character budget per curated file. The self_update tool rejects over-budget writes. */
export const SOUL_BUDGET = 8000;
export const MEMORY_BUDGET = 8000;
export const USER_BUDGET = 8000;

const TRUNCATION_MARKER = "\n\n[... truncated: over budget ...]";

export interface Memory {
	soul: string;
	memory: string;
	user: string;
}

export function readMemoryFile(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

export function writeMemoryFile(path: string, content: string): void {
	writeFileSync(path, content, "utf-8");
}

/** Defensive guard for hand-edited files that exceed the budget. */
function clampToBudget(content: string, budget: number): string {
	if (content.length <= budget) return content;
	return content.slice(0, Math.max(0, budget - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Read the curated files for an agent. Missing files become "". */
export function loadMemory(name: string): Memory {
	return {
		soul: clampToBudget(readMemoryFile(getSoulPath(name)), SOUL_BUDGET),
		memory: clampToBudget(readMemoryFile(getMemoryPath(name)), MEMORY_BUDGET),
		user: clampToBudget(readMemoryFile(getUserMemoryPath(name)), USER_BUDGET),
	};
}
