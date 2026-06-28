/**
 * Per-agent, per-service runtime state for integrations.
 *
 * Where `integration-account-storage.ts` holds the credential/config records an
 * integration is *configured* with, this store holds the machine-written state an
 * integration *accumulates* at runtime (the scheduler's jobs). The on-disk shape is
 * one flat `Record<string, unknown>` per service, each its own file at
 * `~/.wolli/agents/<name>/store/<service>.json`. Keeping high-churn state in a
 * separate per-service file means a per-tick write never rewrites the credentials file.
 *
 * Process-scoped and must survive `/reload`: the producer is torn down + rebuilt on
 * reload, but the store (and the jobs it holds) persists.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { getIntegrationStorePath } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";

/** One service's state file: a flat bag of arbitrary JSON values. */
export type IntegrationStoreData = Record<string, unknown>;

type LockResult<T> = {
	result: T;
	next?: string;
};

const STORE_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface IntegrationStoreBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
}

export class FileIntegrationStoreBackend implements IntegrationStoreBackend {
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
			writeFileSync(this.storagePath, "{}", STORE_FILE_WRITE_OPTIONS);
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

		throw (lastError as Error) ?? new Error("Failed to acquire integration store lock");
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
				writeFileSync(this.storagePath, next, STORE_FILE_WRITE_OPTIONS);
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

export class InMemoryIntegrationStoreBackend implements IntegrationStoreBackend {
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
 * Per-agent integration state store, one JSON file per service. A service's backend is
 * created on first touch; reads and writes go through it under lock, and a write re-reads
 * + merges against the fresh on-disk copy so a concurrent writer to a different key in the
 * same file can't be clobbered.
 */
export class IntegrationStore {
	private backends: Map<string, IntegrationStoreBackend> = new Map();
	private errors: Error[] = [];
	/** Agent name for the file backend; null selects the in-memory backend. */
	private agentName: string | null;

	private constructor(agentName: string | null) {
		this.agentName = agentName;
	}

	/** Per-agent store at `~/.wolli/agents/<name>/store/<service>.json`. */
	static create(agentName: string): IntegrationStore {
		return new IntegrationStore(agentName);
	}

	/** In-memory store seeded from `seed[service]`, for tests. */
	static inMemory(seed: Record<string, IntegrationStoreData> = {}): IntegrationStore {
		const store = new IntegrationStore(null);
		for (const [service, data] of Object.entries(seed)) {
			for (const [key, value] of Object.entries(data)) {
				store.set(service, key, value);
			}
		}
		return store;
	}

	private getBackend(service: string): IntegrationStoreBackend {
		let backend = this.backends.get(service);
		if (!backend) {
			backend =
				this.agentName === null
					? new InMemoryIntegrationStoreBackend()
					: new FileIntegrationStoreBackend(getIntegrationStorePath(this.agentName, service));
			this.backends.set(service, backend);
		}
		return backend;
	}

	private recordError(error: unknown): void {
		this.errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	/** A service's parsed state, read fresh under lock; `{}` on a missing or unreadable file. */
	private read(service: string): IntegrationStoreData {
		try {
			return this.getBackend(service).withLock((current) => ({
				result: current ? (JSON.parse(current) as IntegrationStoreData) : {},
			}));
		} catch (error) {
			this.recordError(error);
			return {};
		}
	}

	/** Read-modify-write a service's file under lock, merging the change against the fresh copy. */
	private write(service: string, mutate: (data: IntegrationStoreData) => void): void {
		try {
			this.getBackend(service).withLock((current) => {
				const data = current ? (JSON.parse(current) as IntegrationStoreData) : {};
				mutate(data);
				return { result: undefined, next: JSON.stringify(data, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	get(service: string, key: string): unknown {
		return this.read(service)[key];
	}

	getAll(service: string): IntegrationStoreData {
		return { ...this.read(service) };
	}

	set(service: string, key: string, value: unknown): void {
		this.write(service, (data) => {
			data[key] = value;
		});
	}

	delete(service: string, key: string): void {
		this.write(service, (data) => {
			delete data[key];
		});
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}
}
