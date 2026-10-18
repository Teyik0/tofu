import "@teyik0/furin/server-only";
import type { SyncRuntimeOptions } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { db } from "./api/lib/database-plugin";

export const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
  principal: () => "local",
} satisfies SyncRuntimeOptions;
