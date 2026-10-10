import { join } from "node:path";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { TofuDatabase } from "../api/lib/db";

export function initializeDatabase(db: TofuDatabase) {
  db.run(sql`PRAGMA journal_mode = WAL`);
  migrate(db, { migrationsFolder: join(import.meta.dir, "drizzle") });
  migrateSqliteSync(db.$client);
}
