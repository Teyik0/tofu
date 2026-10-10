import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";

type SyncedPluginApi = ReturnType<ReturnType<typeof furinSync>>;
const SYNC_API_FACTORY = Symbol.for("tofu.plugin-sync-api-factory.v0");
const sharedGlobal = globalThis as typeof globalThis & {
  [SYNC_API_FACTORY]?: (options: FurinSyncOptions) => SyncedPluginApi;
};
// Packaged plugins and the bundled host must create their macros in the same Furin module instance.
sharedGlobal[SYNC_API_FACTORY] ??= (options) => new Elysia().use(furinSync(options));
const createSyncedApi = sharedGlobal[SYNC_API_FACTORY];

/** Use real host synchronization, or supply real options in a standalone plugin host. */
export function createPluginApi(context: { sync?: FurinSyncOptions }) {
  if (!context.sync) {
    throw new Error("This plugin API requires Furin Sync options from its host");
  }
  return createSyncedApi(context.sync);
}
