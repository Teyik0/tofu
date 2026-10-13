import "@teyik0/furin/server-only";
import type { SyncRuntimeOptions } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { db } from "./api/lib/database-plugin";
import { recordLog } from "./api/lib/diagnostics";
import { resources } from "./api/lib/runtime";
import { ObservedSyncNotifier } from "./api/lib/sync-notifier";
import { engine } from "./api/modules/torrents/plugin";

const notifier = new ObservedSyncNotifier(engine.setObserved.bind(engine));
export const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
  notifier,
  principal: () => "local",
} satisfies SyncRuntimeOptions;

const unsubscribe = engine.subscribeChanges(({ cursor }) => {
  if (cursor !== undefined) {
    void notifier.publish(cursor).catch((error: unknown) => {
      recordLog({ component: "sync", error, level: "error", operation: "publish" });
    });
  }
});
resources.defer(() => {
  unsubscribe();
});
