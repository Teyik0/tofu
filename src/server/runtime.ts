import type { FurinSyncOptions } from "@teyik0/furin/sync";
import type { DesktopController } from "./desktop";
import { type TorrentEngine, UserError } from "./engine";
import type { AutomationService } from "./feeds/service";
import { type acquireInstance, currentInstanceConfig } from "./instance";
import type { createTofuSync } from "./sync";
import type { UpdatesService } from "./updates";

// Bun hot reload replaces HTTP modules without restarting downloads or the journal.
const host = globalThis as typeof globalThis & {
  tofuRuntime?: {
    instance?: Awaited<ReturnType<typeof currentInstanceConfig>>;
    engine?: TorrentEngine;
    sync?: Awaited<ReturnType<typeof createTofuSync>>;
    shutdown?: () => Promise<void>;
    timer?: ReturnType<typeof setInterval>;
    publishing?: Promise<void>;
    automation?: AutomationService;
    updates?: UpdatesService;
    desktop?: DesktopController;
    lease?: Awaited<ReturnType<typeof acquireInstance>>;
    sdk?: typeof import("electrobun/main");
  };
};
host.tofuRuntime ??= {};
export const runtime = host.tofuRuntime;
// Keep the configuration with the engine: hot reload must never relabel a live database.
runtime.instance ??= await currentInstanceConfig();
export const { instance } = runtime;
export const { dataDir } = instance;
function syncAdapter() {
  if (!runtime.sync) {
    throw new UserError("The journal is starting, please wait", { status: 503 });
  }
  return runtime.sync.options.adapter;
}

// Register routes without opening user databases during Furin's build/AOT inspection.
// Only startServer opens the durable journal, after acquiring the instance lock.
export const syncOptions: FurinSyncOptions = {
  adapter: {
    abortMutation: (input) => syncAdapter().abortMutation(input),
    beginMutation: (input) => syncAdapter().beginMutation(input),
    completeMutation: (input) => syncAdapter().completeMutation(input),
    currentCursor: () => syncAdapter().currentCursor(),
    readChanges: (input) => syncAdapter().readChanges(input),
    renewMutation: (input) => syncAdapter().renewMutation(input),
    scope: "host-local",
  },
  principal: () => "local",
};

export function getEngine() {
  if (!runtime.engine) {
    throw new UserError("The engine is starting, please wait", { status: 503 });
  }
  return runtime.engine;
}
export function getAutomation() {
  if (!runtime.automation) {
    throw new UserError("Automations are starting", { status: 503 });
  }
  return runtime.automation;
}

export function getUpdates() {
  if (!runtime.updates) {
    throw new UserError("Updates are starting", { status: 503 });
  }
  return runtime.updates;
}
export function getDesktop() {
  if (!runtime.desktop) {
    throw new UserError("The desktop app is starting", { status: 503 });
  }
  return runtime.desktop;
}

export function getNativeSdk() {
  if (!runtime.sdk) {
    throw new UserError("The native host is starting", { status: 503 });
  }
  return runtime.sdk;
}
