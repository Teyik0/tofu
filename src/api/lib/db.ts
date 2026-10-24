import "@teyik0/furin/server-only";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { furinSyncSchema } from "../../db/furin.schema";
import { schema } from "../../db/schema";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { lifecyclePlugin } from "./lifecycle-plugin";
import Elysia from "elysia";
import { databasePath } from "../../../drizzle.config";

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

export const databasePlugin = new Elysia({ name: "tofu-database-service" })
  .use(lifecyclePlugin)
  .onStart(initializeDatabase)
  .onStop(() => db.$client.close())
  .decorate("db", db);
