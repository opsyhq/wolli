/**
 * Per-agent "Always allow" rules for host escalation, at `~/.wolli/agents/<name>/approvals.json`.
 * Mirrors `integration-account-storage.ts` (proper-lockfile, File/InMemory backends). A rule stores a
 * command prefix (`git push origin main` -> `["git","push"]`); compound commands and bare interpreters
 * are never remembered and never match.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { getAgentApprovalsPath } from "../../config.ts";
import { normalizePath } from "../../utils/paths.ts";

const SCHEMA_VERSION = 1;

/** A single persisted prefix rule. */
export interface ApprovalRule {
	target: string;
	prefix: string[];
	createdAt: number;
}

/** On-disk shape: a versioned list of prefix rules. */
export interface AgentApprovals {
	schemaVersion: number;
	rules: ApprovalRule[];
}

/** First tokens that hide the real program in a later arg — never persistable. */
const INTERPRETERS = new Set(["bash", "sh", "zsh", "node", "python", "python3", "sudo", "env", "eval"]);

/** Leading tokens that identify a command family. Defaults to 1 (the program). */
const ARITY: Record<string, number> = {
	git: 2,
	"npm run": 3,
	npm: 2,
	pnpm: 2,
	yarn: 2,
	"docker compose": 3,
	docker: 2,
	cargo: 2,
};

/** Shell metacharacters making a command compound/redirecting/subshelling. */
const COMPOUND = /[|&;<>$`(){}]/;

/** Reduce a command to its persistable prefix, or null if it must never be remembered. */
export function toPrefix(command: string): string[] | null {
	if (COMPOUND.test(command)) return null;
	const argv = command.trim().split(/\s+/);
	if (!argv[0] || INTERPRETERS.has(argv[0])) return null;
	const n = ARITY[`${argv[0]} ${argv[1]}`] ?? ARITY[argv[0]] ?? 1;
	return argv.slice(0, n);
}

/** Whether `prefix` is a leading run of `argv`. */
function matchesPrefix(prefix: string[], argv: string[]): boolean {
	return argv.length >= prefix.length && prefix.every((token, i) => argv[i] === token);
}

function samePrefix(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((token, i) => token === b[i]);
}

type LockResult<T> = {
	result: T;
	next?: string;
};

const APPROVALS_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

const EMPTY_APPROVALS: AgentApprovals = { schemaVersion: SCHEMA_VERSION, rules: [] };

export interface ApprovalStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
}

export class FileApprovalStorageBackend implements ApprovalStorageBackend {
	private storagePath: string;

	constructor(storagePath: string) {
		this.storagePath = normalizePath(storagePath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.storagePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.storagePath)) {
			writeFileSync(this.storagePath, JSON.stringify(EMPTY_APPROVALS, null, 2), APPROVALS_FILE_WRITE_OPTIONS);
			chmodSync(this.storagePath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire approvals lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.storagePath);
			const current = existsSync(this.storagePath) ? readFileSync(this.storagePath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.storagePath, next, APPROVALS_FILE_WRITE_OPTIONS);
				chmodSync(this.storagePath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemoryApprovalStorageBackend implements ApprovalStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

export class ApprovalStore {
	private data: AgentApprovals = { schemaVersion: SCHEMA_VERSION, rules: [] };
	private storage: ApprovalStorageBackend;

	private constructor(storage: ApprovalStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	/** Per-agent store at `~/.wolli/agents/<name>/approvals.json`. */
	static create(name: string): ApprovalStore {
		return new ApprovalStore(new FileApprovalStorageBackend(getAgentApprovalsPath(name)));
	}

	static fromStorage(storage: ApprovalStorageBackend): ApprovalStore {
		return new ApprovalStore(storage);
	}

	static inMemory(data: AgentApprovals = EMPTY_APPROVALS): ApprovalStore {
		const storage = new InMemoryApprovalStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return ApprovalStore.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AgentApprovals {
		if (!content) {
			return { schemaVersion: SCHEMA_VERSION, rules: [] };
		}
		const parsed = JSON.parse(content) as Partial<AgentApprovals>;
		return {
			schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
			rules: Array.isArray(parsed.rules) ? parsed.rules : [],
		};
	}

	/** Reload rules from storage. */
	reload(): void {
		try {
			this.storage.withLock((current) => {
				this.data = this.parseStorageData(current);
				return { result: undefined };
			});
		} catch {
			// Unreadable/corrupt store: keep the empty default; persistence stays best-effort.
		}
	}

	/** Whether a stored rule for `target` covers `command`. */
	isAllowed(target: string, command: string): boolean {
		// Compound commands never match — else a `git push` rule allows `git push && rm -rf /`.
		if (COMPOUND.test(command)) return false;
		const argv = command.trim().split(/\s+/);
		return this.data.rules.some((rule) => rule.target === target && matchesPrefix(rule.prefix, argv));
	}

	/** Persist a prefix rule for `command` on `target`. No-op when not persistable. */
	allow(command: string, target: string): void {
		const prefix = toPrefix(command);
		if (!prefix) {
			return;
		}
		try {
			this.storage.withLock((current) => {
				// Re-read under lock and merge, so a concurrent writer's rules survive.
				const merged = this.parseStorageData(current);
				if (merged.rules.some((rule) => rule.target === target && samePrefix(rule.prefix, prefix))) {
					this.data = merged;
					return { result: undefined };
				}
				merged.rules.push({ target, prefix, createdAt: Date.now() });
				this.data = merged;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch {
			// Best-effort: a failed write just means a re-prompt next time.
		}
	}

	/** Whether `command` can be remembered (gate uses this to show/hide "Always allow"). */
	canRemember(command: string): boolean {
		return toPrefix(command) !== null;
	}

	/** All stored rules (snapshot). */
	getRules(): ApprovalRule[] {
		return [...this.data.rules];
	}
}
