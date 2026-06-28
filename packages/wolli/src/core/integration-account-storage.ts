/**
 * Per-agent account storage for integrations.
 *
 * Each account record holds whatever one configured account needs — credentials
 * and plain config alike (e.g. heartbeat's `{ intervalMs }`). The on-disk shape is
 * nested `Record<service, Record<accountId, AccountRecord>>` (integrations are
 * multi-account). The store lives at `~/.wolli/agents/<name>/integrations.json`,
 * is process-scoped, and must survive `/reload` so per-account state isn't lost.
 *
 * Pure persistence: stores and returns RAW records; the runner resolves + validates
 * them into `ctx.account`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { getAgentIntegrationsPath } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";

/** One configured account: an open bag of string/literal fields. */
export type IntegrationAccountRecord = Record<string, unknown>;

/** Nested on-disk shape: service → accountId → record. */
export type IntegrationAccountStorageData = Record<string, Record<string, IntegrationAccountRecord>>;

type LockResult<T> = {
	result: T;
	next?: string;
};

const ACCOUNT_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface IntegrationAccountStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
}

export class FileIntegrationAccountStorageBackend implements IntegrationAccountStorageBackend {
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
			writeFileSync(this.storagePath, "{}", ACCOUNT_FILE_WRITE_OPTIONS);
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

		throw (lastError as Error) ?? new Error("Failed to acquire integration account lock");
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
				writeFileSync(this.storagePath, next, ACCOUNT_FILE_WRITE_OPTIONS);
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

export class InMemoryIntegrationAccountStorageBackend implements IntegrationAccountStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Per-agent integration account store backed by a nested JSON file.
 */
export class IntegrationAccountStorage {
	private data: IntegrationAccountStorageData = {};
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: IntegrationAccountStorageBackend;

	private constructor(storage: IntegrationAccountStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	/** Per-agent store at `~/.wolli/agents/<name>/integrations.json`. */
	static create(agentName: string): IntegrationAccountStorage {
		return new IntegrationAccountStorage(
			new FileIntegrationAccountStorageBackend(getAgentIntegrationsPath(agentName)),
		);
	}

	static fromStorage(storage: IntegrationAccountStorageBackend): IntegrationAccountStorage {
		return new IntegrationAccountStorage(storage);
	}

	static inMemory(data: IntegrationAccountStorageData = {}): IntegrationAccountStorage {
		const storage = new InMemoryIntegrationAccountStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return IntegrationAccountStorage.fromStorage(storage);
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): IntegrationAccountStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as IntegrationAccountStorageData;
	}

	/** Reload accounts from storage. */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistServiceChange(service: string, accounts: Record<string, IntegrationAccountRecord> | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: IntegrationAccountStorageData = { ...currentData };
				if (accounts && Object.keys(accounts).length > 0) {
					merged[service] = accounts;
				} else {
					delete merged[service];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/** Get an account record for `(service, accountId)`. */
	get(service: string, accountId: string): IntegrationAccountRecord | undefined {
		return this.data[service]?.[accountId] ?? undefined;
	}

	/** Set an account record, creating the inner per-service record on demand. */
	set(service: string, accountId: string, record: IntegrationAccountRecord): void {
		const accounts = { ...(this.data[service] ?? {}) };
		accounts[accountId] = record;
		this.data[service] = accounts;
		this.persistServiceChange(service, accounts);
	}

	/** Remove an account; prunes the service key when its last account is removed. */
	remove(service: string, accountId: string): void {
		const accounts = { ...(this.data[service] ?? {}) };
		delete accounts[accountId];
		if (Object.keys(accounts).length > 0) {
			this.data[service] = accounts;
		} else {
			delete this.data[service];
		}
		this.persistServiceChange(service, this.data[service]);
	}

	/** Whether `(service, accountId)` has a configured record. */
	has(service: string, accountId: string): boolean {
		return Boolean(this.data[service] && accountId in this.data[service]);
	}

	/** Account ids configured under one service. */
	listAccounts(service: string): string[] {
		return this.data[service] ? Object.keys(this.data[service]) : [];
	}

	/** All configured service keys. */
	listServices(): string[] {
		return Object.keys(this.data);
	}

	getAll(): IntegrationAccountStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}
}
