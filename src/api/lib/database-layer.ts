import "@teyik0/furin/server-only";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer } from "effect";
import { databasePath } from "../../../drizzle.config";
import { furinSyncSchema } from "../../db/furin.schema";
import { schema } from "../../db/schema";

export type DatabaseInstance = ReturnType<typeof drizzle>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseInstance["transaction"]>[0]>[0];
export type DatabaseConnection = DatabaseInstance | DatabaseTransaction;

export class Database extends Context.Service<Database, DatabaseInstance>()("tofu/database") {}

export const databaseLayer = Layer.effect(
  Database,
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(dirname(databasePath), { recursive: true }));

    const db = yield* Effect.acquireRelease(
      Effect.try(() => drizzle(databasePath)),
      (connection) => Effect.sync(() => connection.$client.close())
    );

    yield* Effect.try(() => {
      db.run(sql`PRAGMA busy_timeout = 5000`);
      db.run(sql`PRAGMA journal_mode = WAL`);
      migrate(db, { migrationsFolder: join(import.meta.dir, "../../db/drizzle") });
      migrateSqliteSync(db.$client);

      for (const table of Object.values(schema)) {
        db.select().from(table).limit(0).all();
      }
      for (const table of Object.values(furinSyncSchema)) {
        db.select({ namespace: table.namespace }).from(table).limit(0).all();
      }
    });

    return db;
  })
);
