import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, initLogger } from "evlog";
import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { assertDatabaseReady, openDatabase } from "./db";
import { loggerConfig, sanitizeLog } from "./diagnostics";
import { acquireInstance, currentInstanceConfig } from "./instance";
import { logDirectory, logDrain } from "./logs";

export const instance = currentInstanceConfig();
export const lease = await acquireInstance(instance);

export const logs = logDrain;

try {
  await mkdir(logDirectory, { mode: 0o700, recursive: true });
  await chmod(logDirectory, 0o700);
  const file = await open(
    join(logDirectory, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    "a",
    0o600
  );
  try {
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
} catch (error) {
  await lease.close();
  throw error;
}
initLogger({ ...loggerConfig, drain: logDrain });
const startupLog = createLogger({
  component: "application",
  context: {
    mode: instance.desktop ? "desktop" : "server",
    platform: process.platform,
    profile: instance.profile,
  },
  dataDir: instance.dataDir,
  operation: "startup",
});
startupLog.emit();
export const db = await (async () => {
  try {
    const database = await openDatabase(instance.dataDir);
    try {
      assertDatabaseReady(database);
    } catch (error) {
      database.$client.close(true);
      throw error;
    }
    return database;
  } catch (error) {
    const log = createLogger({
      component: "database",
      dataDir: instance.dataDir,
      error: sanitizeLog(error),
      operation: "startup",
    });
    log.setLevel("error");
    log.emit();
    try {
      await logDrain.flush();
    } finally {
      await lease.close();
    }
    throw error;
  }
})();
export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);
