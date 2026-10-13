import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { assertDatabaseReady, openDatabase } from "./db";
import { acquireInstance, currentInstanceConfig } from "./instance";
import { resources } from "./runtime";

export const instance = currentInstanceConfig();
const lease = await acquireInstance(instance);
resources.defer(lease.close.bind(lease));
export const db = await openDatabase(instance.dataDir);
resources.defer(() => db.$client.close(true));
assertDatabaseReady(db);
export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);
