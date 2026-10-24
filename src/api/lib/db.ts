import "@teyik0/furin/server-only";
import { join } from "node:path";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import Elysia from "elysia";
import { databasePath } from "../../../drizzle.config";
import { furinSyncSchema } from "../../db/furin.schema";
import { schema } from "../../db/schema";

export const db = drizzle(databasePath);

function initializeDatabase() {
  db.run(sql`PRAGMA journal_mode = WAL`);
  migrate(db, { migrationsFolder: join(import.meta.dir, "../../db/drizzle") });
  migrateSqliteSync(db.$client);

  for (const table of Object.values(schema)) {
    db.select().from(table).limit(0).all();
  }
  for (const table of Object.values(furinSyncSchema)) {
    db.select({ namespace: table.namespace }).from(table).limit(0).all();
  }
}

// Will be used when the global SDK will be available
// For now use global export const db instance in any services that need it
export const databasePlugin = new Elysia({ name: "tofu-database-service" })
  .onStart(initializeDatabase)
  .onStop(() => db.$client.close())
  .decorate("db", db);
