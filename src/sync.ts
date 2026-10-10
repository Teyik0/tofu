import "@teyik0/furin/server-only";
import type { FurinSyncOptions, TransactionalSyncAdapter } from "@teyik0/furin/sync";
import type { DatabaseTransaction } from "./api/lib/db";
import { services } from "./api/lib/services";

// Route registration is side-effect free. Startup binds one real Drizzle adapter
// to the same connection used by automations and their atomic sync mutations.
const adapter = {
  abortMutation: (lease) => services.syncAdapter.abortMutation(lease),
  beginMutation: (input) => services.syncAdapter.beginMutation(input),
  completeMutation: (input) => services.syncAdapter.completeMutation(input),
  currentCursor: () => services.syncAdapter.currentCursor(),
  executeMutation: (lease, callback) => services.syncAdapter.executeMutation(lease, callback),
  readChanges: (input) => services.syncAdapter.readChanges(input),
  renewMutation: (lease) => services.syncAdapter.renewMutation(lease),
  scope: "host-local",
  transactionMode: "sync",
} satisfies TransactionalSyncAdapter<DatabaseTransaction, "sync">;

export const sync = {
  adapter,
  principal: () => "local",
} satisfies FurinSyncOptions;
