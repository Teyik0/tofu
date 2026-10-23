import "@teyik0/furin/server-only";
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeDatabase } from "../../db/migrations";
import { schema } from "../../db/schema";

export function createDatabase(path: string) {
  using startup = new DisposableStack();
  const client = new Database(path, { create: true, strict: true });
  startup.defer(client.close.bind(client, true));
  // The worker and API own separate handles to the same WAL database.
  client.run("PRAGMA busy_timeout = 5000");
  const connection = drizzle({ client, schema });
  startup.move();
  return connection;
}

export async function openDatabase(directory: string) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, "feeds.sqlite");
  await using startup = new AsyncDisposableStack();
  const connection = createDatabase(path);
  startup.defer(connection.$client.close.bind(connection.$client, true));
  initializeDatabase(connection);
  await chmod(path, 0o600);
  startup.move();
  return connection;
}

export function assertDatabaseReady(connection: TofuDatabase) {
  for (const table of Object.values(schema)) {
    connection.select().from(table).limit(0).all();
  }
  connection.run(sql`SELECT 1 FROM
    furin_sync_mutations, furin_sync_streams, furin_sync_changes
    LIMIT 0`);
}

export type TofuDatabase = ReturnType<typeof createDatabase>;
export type DatabaseTransaction = Parameters<Parameters<TofuDatabase["transaction"]>[0]>[0];
export type DatabaseConnection = TofuDatabase | DatabaseTransaction;
