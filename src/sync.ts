import "@teyik0/furin/server-only";
import type { TransactionalSyncAdapter } from "@teyik0/furin/sync";
import type { DatabaseTransaction } from "./api/lib/db";
import { applicationHost, applicationScope } from "./api/lib/host";
import type { CoreApplication } from "./types";

// Furin registers routes before startup. Only its transport waits for the real adapter.
export function createDeferredSync(ready: () => Promise<CoreApplication>) {
  const adapter = {
    abortMutation: async (lease) => (await ready()).sync.adapter.abortMutation(lease),
    beginMutation: async (input) => (await ready()).sync.adapter.beginMutation(input),
    completeMutation: async (input) => (await ready()).sync.adapter.completeMutation(input),
    currentCursor: async () => (await ready()).sync.adapter.currentCursor(),
    executeMutation: async (lease, callback) =>
      (await ready()).sync.adapter.executeMutation(lease, callback),
    readChanges: async (input) => (await ready()).sync.adapter.readChanges(input),
    renewMutation: async (lease) => (await ready()).sync.adapter.renewMutation(lease),
    scope: "host-local",
    transactionMode: "sync",
  } satisfies TransactionalSyncAdapter<DatabaseTransaction, "sync">;
  return { adapter, principal: () => "local" };
}

export const sync = createDeferredSync(() => {
  const application = applicationScope.getStore();
  return application ? Promise.resolve(application) : applicationHost.core;
});
