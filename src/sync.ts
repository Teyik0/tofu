import "@teyik0/furin/server-only";
import type { FurinSyncOptions } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { createContext } from "elysia";
import { db } from "./api/lib/services-runtime";
import { accessPlugin } from "./api/modules/access/plugin";
import { callers } from "./api/modules/access/service";

const { access } = createContext(accessPlugin).prototype;

export const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
  connection({ request }) {
    const caller = callers.get(request);
    if (!caller || caller.kind === "anonymous") {
      return;
    }
    return access.callerReader(caller, request);
  },
  // Idempotency belongs to the authenticated device, never to its current grants.
  principal({ request }) {
    const caller = callers.get(request);
    if (!caller) {
      return "shared";
    }
    return caller.kind === "anonymous" ? `anonymous:${crypto.randomUUID()}` : caller.principal;
  },
} satisfies FurinSyncOptions;
