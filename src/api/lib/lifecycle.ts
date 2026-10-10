import type { SyncRuntimeOptions, TransactionalSyncAdapter } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { version } from "../../../package.json";
import { sync } from "../../sync";
import { readAniListClient } from "../modules/anilist/client";
import { AutomationService } from "../modules/automation/service";
import { pluginEndpoints } from "../modules/plugins/service";
import { WorkerTorrentEngine } from "../modules/torrents/worker-client";
import { UpdatesService } from "../modules/updates/service";
import { assertDatabaseReady, type DatabaseTransaction, openDatabase } from "./db";
import { acquireInstance } from "./instance";
import { dataDir, getDesktop, getNativeSdk, instance, runtime } from "./runtime";
import { services } from "./services";

export async function assertRuntimeReady() {
  const { engine, db } = runtime;
  if (!engine) {
    throw new Error("The torrent engine has not been initialized");
  }
  if (!db) {
    throw new Error("The database has not been initialized");
  }
  assertDatabaseReady(db);
  await engine.assertReady();
}

export async function onStartup(signal: AbortSignal) {
  // Elysia runs setup hooks concurrently; the native host also starts before listening.
  // Share initialization so every caller waits for the same resources.
  signal.throwIfAborted();
  runtime.startupController ??= new AbortController();
  const controller = runtime.startupController;
  signal.addEventListener("abort", () => controller.abort(signal.reason), {
    once: true,
    signal: controller.signal,
  });
  runtime.starting ??= start(controller.signal);
  await runtime.starting;
}

async function start(signal: AbortSignal) {
  runtime.closing = false;
  try {
    signal.throwIfAborted();
    await initialize(signal);
    signal.throwIfAborted();
  } catch (error) {
    runtime.closing = false;
    await onShutdown();
    throw error;
  }
}

export async function onShutdown() {
  if (runtime.closing) {
    return;
  }
  runtime.closing = true;
  runtime.startupController?.abort();
  runtime.updates?.close();
  clearInterval(runtime.timer);
  await runtime.publishing;
  try {
    await runtime.automation?.close();
    await runtime.engine?.close();
  } finally {
    runtime.db?.$client.close();
    await runtime.lease?.close();
    runtime.engine = undefined;
    runtime.automation = undefined;
    runtime.db = undefined;
    runtime.lease = undefined;
    runtime.updates = undefined;
    runtime.starting = undefined;
    runtime.startupController = undefined;
  }
}

async function initialize(signal: AbortSignal) {
  const { desktop } = instance;
  const sdk = desktop ? getNativeSdk() : null;
  runtime.lease ??= await acquireInstance(instance);
  signal.throwIfAborted();
  runtime.db ??= await openDatabase(dataDir);
  services.syncAdapter = drizzleSyncAdapter({ db: runtime.db, namespace: "tofu" });
  signal.throwIfAborted();
  const engine =
    runtime.engine ??
    (await WorkerTorrentEngine.open({
      dataDir,
      downloadPath: instance.downloadPath,
      network: { maxConns: 100, userAgent: `Tofu/${version}`, utp: false },
    }));
  runtime.engine = engine;
  services.engine = engine;
  signal.throwIfAborted();
  const anilistClient = await readAniListClient(
    instance.profile,
    process.env.TOFU_ANILIST_CLIENT_ID,
    process.execPath
  );
  runtime.automation ??= await AutomationService.open(
    {
      anilistClient,
      dataDir,
      endpoints: pluginEndpoints,
      engine: () => services.engine,
      now: Date.now,
    },
    runtime.db
  );
  signal.throwIfAborted();
  void runtime.automation.start().catch(console.error);
  engine.mode = desktop ? "desktop" : "server";
  runtime.updates ??= await UpdatesService.open({
    apiOrigin: "https://api.github.com",
    arch: process.arch,
    dataDir,
    native:
      sdk && instance.profile === "release"
        ? {
            applyUpdate: () => getDesktop().installUpdate(),
            checkForUpdate: sdk.Updater.checkForUpdate,
            downloadUpdate: sdk.Updater.downloadUpdate,
            onStatusChange: sdk.Updater.onStatusChange,
            updateInfo: sdk.Updater.updateInfo,
          }
        : undefined,
    notify: (latest) => {
      if (desktop) {
        Promise.resolve(
          getNativeSdk().Utils.showNotification({
            body: `Open ${instance.name} to update to the new version.`,
            title: `${instance.name} : Tofu ${latest} is available`,
          })
        ).catch(console.error);
      }
    },
    platform: process.platform,
    version,
  });
  signal.throwIfAborted();
  runtime.updates.start();
  clearInterval(runtime.timer);
  runtime.timer = setInterval(() => {
    if (!runtime.publishing) {
      runtime.publishing = publishEngineChanges(sync)
        .catch(console.error)
        .finally(() => {
          runtime.publishing = undefined;
        });
    }
  }, 1000);
  runtime.timer.unref();
}

// Worker events originate outside HTTP mutations and still need durable invalidations.
export async function publishEngineChanges(
  options: SyncRuntimeOptions<TransactionalSyncAdapter<DatabaseTransaction, "sync">>
) {
  const reservation = await options.adapter.beginMutation({
    fingerprint: "live",
    key: crypto.randomUUID(),
    principal: "local",
  });
  if (reservation.kind === "execute") {
    await options.adapter.executeMutation(reservation.lease, () => ({
      invalidations: [{ kind: "path", path: "/", type: "layout" }],
      response: { body: new Uint8Array(), headers: [], status: 204 },
      value: undefined,
    }));
  }
}
