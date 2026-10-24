import "@teyik0/furin/server-only";
import type { SyncRuntimeOptions } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { db } from "./api/lib/db";
import { callers } from "./api/modules/access/service";

export const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
  // Idempotency belongs to the authenticated device, never to its current grants.
  principal({ request }) {
    const caller = callers.get(request);
    if (!caller) {
      return "shared";
    }
    return caller.kind === "anonymous" ? `anonymous:${crypto.randomUUID()}` : caller.principal;
  },
} satisfies SyncRuntimeOptions;
