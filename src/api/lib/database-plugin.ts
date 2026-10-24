import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { assertDatabaseReady, openDatabase } from "./db";
import { acquireInstance, currentInstanceConfig } from "./instance";
import { lifecyclePlugin, reserveInitialization, resources } from "./lifecycle-plugin";
import { logDirectory, logDrain } from "./logs";

using _initialization = reserveInitialization();
await using startup = new AsyncDisposableStack();

export const instance = currentInstanceConfig();
export const lease = await acquireInstance(instance);
startup.defer(lease.close.bind(lease));

export const logs = logDrain;
startup.defer(logs.flush.bind(logs));

await mkdir(logDirectory, { mode: 0o700, recursive: true });
await chmod(logDirectory, 0o700);
{
  await using file = await open(
    join(logDirectory, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    "a",
    0o600
  );
  await file.chmod(0o600);
}
export const db = await openDatabase(instance.dataDir);
startup.defer(db.$client.close.bind(db.$client, true));
assertDatabaseReady(db);

export const databasePlugin = new Elysia({ name: "tofu-database-service" })
  .use(lifecyclePlugin)
  .decorate("db", db);

resources.use(startup.move());
