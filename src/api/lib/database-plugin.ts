import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { assertDatabaseReady, openDatabase } from "./db";
import { recordLog } from "./diagnostics";
import { acquireInstance, currentInstanceConfig } from "./instance";
import { ApplicationLogs } from "./logs";
import { resources } from "./runtime";

export const instance = currentInstanceConfig();
const lease = await acquireInstance(instance);
resources.defer(lease.close.bind(lease));
export const logs = await (async () => {
  try {
    return await ApplicationLogs.open({ dataDir: instance.dataDir });
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
})();
resources.defer(logs.close.bind(logs));
recordLog({
  component: "application",
  context: {
    mode: instance.desktop ? "desktop" : "server",
    platform: process.platform,
    profile: instance.profile,
  },
  dataDir: instance.dataDir,
  level: "info",
  operation: "startup",
});
export const db = await (async () => {
  try {
    const database = await openDatabase(instance.dataDir);
    resources.defer(() => database.$client.close(true));
    assertDatabaseReady(database);
    return database;
  } catch (error) {
    recordLog({
      component: "database",
      dataDir: instance.dataDir,
      error,
      level: "error",
      operation: "startup",
    });
    await resources.disposeAsync();
    throw error;
  }
})();
export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);
