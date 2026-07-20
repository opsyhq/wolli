import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { WorkflowDb } from "./workflow/schema.ts";
import { workflowSchema } from "./workflow/schema.ts";

/** Opens (creating if needed) a wolli sqlite db and applies core's migrations. */
export function openDb(path: string): WorkflowDb {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  const db = drizzle(sqlite, { schema: workflowSchema });
  migrate(db, {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
  return db;
}
