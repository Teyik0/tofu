import "@teyik0/furin/server-only";
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  migrateAutomationDatabase,
  migrateLegacyTorrents,
  migrateSyncDatabase,
} from "../../db/migrations";
import { schema } from "../../db/schema";

export function createDatabase(path: string) {
  const client = new Database(path, { create: true, strict: true });
  // The worker and API own separate handles to the same WAL database.
  client.run("PRAGMA busy_timeout = 5000");
  return drizzle({ client, schema });
}

export async function openDatabase(directory: string) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, "feeds.sqlite");
  const connection = createDatabase(path);
  try {
    migrateAutomationDatabase(connection);
    await migrateSyncDatabase(connection, join(directory, "sync.sqlite"));
    await migrateLegacyTorrents(connection, join(directory, "tofu.sqlite"));
    await chmod(path, 0o600);
    return connection;
  } catch (error) {
    connection.$client.close();
    throw error;
  }
}

export function assertDatabaseReady(connection: TofuDatabase) {
  const migration = connection.get<[number]>(
    sql`SELECT count(*) FROM tofu_migrations
      WHERE id IN ('sync-in-feeds', 'torrents-in-feeds') HAVING count(*) = 2`
  );
  if (!migration) {
    throw new Error("The database migrations are incomplete");
  }
  connection.run(sql`SELECT 1 FROM
    plugins, automations, decisions, judgements, releases, preferences, anilist,
    config, torrents, destinations, furin_sync_mutations, furin_sync_streams, furin_sync_changes
    LIMIT 0`);
}

export type TofuDatabase = ReturnType<typeof createDatabase>;
export type DatabaseTransaction = Parameters<Parameters<TofuDatabase["transaction"]>[0]>[0];
export type DatabaseConnection = TofuDatabase | DatabaseTransaction;
