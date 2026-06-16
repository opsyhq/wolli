/**
 * Per-agent credential storage for integrations.
 *
 * The on-disk shape is nested `Record<service, Record<accountId, AccountRecord>>`
 * (integrations are multi-account), and `resolveAccount` resolves + schema-validates
 * a record on read. The store lives at `~/.steward/agents/<name>/integrations.json`,
 * is process-scoped, and must survive `/reload` so per-account state isn't lost.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { getAgentIntegrationsPath } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

/** One configured account: an open bag of string/literal fields. */
export type IntegrationAccountRecord = Record<string, unknown>;

/** Nested on-disk shape: service → accountId → record. */
export type IntegrationCredentialStoreData = Record<string, Record<string, IntegrationAccountRecord>>;

type LockResult<T> = {
	result: T;
	next?: string;
};

const CRED_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface IntegrationCredentialBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileIntegrationCredentialBackend implements IntegrationCredentialBackend {
	private credPath: string;

	constructor(credPath: string) {
		this.credPath = normalizePath(credPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.credPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.credPath)) {
			writeFileSync(this.credPath, "{}", CRED_FILE_WRITE_OPTIONS);
			chmodSync(this.credPath, 0o600);
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

		throw (lastError as Error) ?? new Error("Failed to acquire integration credential lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.credPath);
			const current = existsSync(this.credPath) ? readFileSync(this.credPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.credPath, next, CRED_FILE_WRITE_OPTIONS);
				chmodSync(this.credPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Integration credential lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.credPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.credPath) ? readFileSync(this.credPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.credPath, next, CRED_FILE_WRITE_OPTIONS);
				chmodSync(this.credPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryIntegrationCredentialBackend implements IntegrationCredentialBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Per-agent integration credential store backed by a nested JSON file.
 */
export class IntegrationCredentialStore {
	private data: IntegrationCredentialStoreData = {};
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: IntegrationCredentialBackend;

	private constructor(storage: IntegrationCredentialBackend) {
		this.storage = storage;
		this.reload();
	}

	/** Per-agent store at `~/.steward/agents/<name>/integrations.json`. */
	static create(agentName: string): IntegrationCredentialStore {
		return new IntegrationCredentialStore(new FileIntegrationCredentialBackend(getAgentIntegrationsPath(agentName)));
	}

	static fromStorage(storage: IntegrationCredentialBackend): IntegrationCredentialStore {
		return new IntegrationCredentialStore(storage);
	}

	static inMemory(data: IntegrationCredentialStoreData = {}): IntegrationCredentialStore {
		const storage = new InMemoryIntegrationCredentialBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return IntegrationCredentialStore.fromStorage(storage);
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): IntegrationCredentialStoreData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as IntegrationCredentialStoreData;
	}

	/** Reload credentials from storage. */
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
				const merged: IntegrationCredentialStoreData = { ...currentData };
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
	list(service: string): string[] {
		return this.data[service] ? Object.keys(this.data[service]) : [];
	}

	/** All configured service keys. */
	listServices(): string[] {
		return Object.keys(this.data);
	}

	getAll(): IntegrationCredentialStoreData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Read a stored account record, resolve its string fields, and validate it.
	 *
	 * Each STRING field is run through `resolveConfigValue` (literal/`$ENV`/`${ENV}`/
	 * `!command`); non-string fields pass through untouched, and a field that resolves
	 * to `undefined` is dropped (so a `schema` check then fails cleanly, mirroring
	 * `resolveHeaders`). The result becomes `ctx.account`.
	 *
	 * Validation is owned here (the cold path) rather than in the runner's `bindCore`:
	 * the runner pre-compiles only the hot-path event/action validators.
	 */
	resolveAccount(service: string, accountId: string, schema?: TSchema): IntegrationAccountRecord {
		const record = this.get(service, accountId);
		if (!record) {
			const configured = this.list(service);
			throw new Error(
				`account '${accountId}' not configured for '${service}'${
					configured.length > 0 ? ` (configured: ${configured.join(", ")})` : ""
				}`,
			);
		}

		const resolved: IntegrationAccountRecord = {};
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "string") {
				const resolvedValue = resolveConfigValue(value);
				if (resolvedValue !== undefined) {
					resolved[key] = resolvedValue;
				}
				continue;
			}
			resolved[key] = value;
		}

		if (schema) {
			const validator = Compile(schema);
			if (!validator.Check(resolved)) {
				const detail = validator
					.Errors(resolved)
					.map((error) => `${error.instancePath || "root"}: ${error.message}`)
					.join("; ");
				throw new Error(
					`Invalid account '${accountId}' for '${service}'${detail ? `: ${detail}` : ""}`,
				);
			}
		}

		return resolved;
	}
}
