import type { SyncRuntimeOptions, TransactionalSyncAdapter } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { version } from "../../../package.json";
import type { CoreApplication, EnginePort } from "../../types";
import { readAniListClient } from "../modules/anilist/client";
import { AutomationService } from "../modules/automation/service";
import { pluginEndpoints } from "../modules/plugins/service";
import { WorkerTorrentEngine } from "../modules/torrents/worker-client";
import { UpdatesService } from "../modules/updates/service";
import { assertDatabaseReady, type DatabaseTransaction, openDatabase } from "./db";
import { applicationHost, hostIntegration, instance } from "./host";
import { acquireInstance } from "./instance";

export async function assertApplicationReady(application: Pick<CoreApplication, "db" | "engine">) {
  assertDatabaseReady(application.db);
  await application.engine.assertReady();
}

export async function onStartup(signal: AbortSignal) {
  const core = await applicationHost.prepare(openCoreApplication, signal);
  if (!instance.desktop) {
    applicationHost.activate(core, { kind: "server" });
  }
}

export function onShutdown() {
  return applicationHost.stop();
}

export async function openCoreApplication(signal: AbortSignal): Promise<CoreApplication> {
  const resources = new AsyncDisposableStack();
  try {
    signal.throwIfAborted();
    const sdk = hostIntegration.tofuNativeSdk;
    if (instance.desktop && !sdk) {
      throw new Error("The native SDK must be supplied before desktop startup");
    }
    const lease = await acquireInstance(instance);
    resources.defer(() => lease.close());
    signal.throwIfAborted();
    const db = await openDatabase(instance.dataDir);
    resources.defer(() => db.$client.close());
    assertDatabaseReady(db);
    signal.throwIfAborted();
    const engine = await WorkerTorrentEngine.open({
      dataDir: instance.dataDir,
      downloadPath: instance.downloadPath,
      network: { maxConns: 100, userAgent: `Tofu/${version}`, utp: false },
    });
    resources.defer(() => engine.close());
    engine.mode = instance.desktop ? "desktop" : "server";
    await assertApplicationReady({ db, engine });
    signal.throwIfAborted();
    const anilistClient = await readAniListClient(
      instance.profile,
      process.env.TOFU_ANILIST_CLIENT_ID,
      process.execPath
    );
    const automation = await AutomationService.open(
      {
        anilistClient,
        dataDir: instance.dataDir,
        endpoints: pluginEndpoints,
        engine: () => engine,
        now: Date.now,
      },
      db
    );
    resources.defer(() => automation.close());
    signal.throwIfAborted();
    const updates = await UpdatesService.open({
      apiOrigin: "https://api.github.com",
      arch: process.arch,
      dataDir: instance.dataDir,
      native:
        sdk && instance.profile === "release"
          ? {
              applyUpdate: async () => {
                const application = await applicationHost.application;
                if (application.platform.kind === "desktop") {
                  await application.platform.controller.installUpdate();
                }
              },
              checkForUpdate: sdk.Updater.checkForUpdate,
              downloadUpdate: sdk.Updater.downloadUpdate,
              onStatusChange: sdk.Updater.onStatusChange,
              updateInfo: sdk.Updater.updateInfo,
            }
          : undefined,
      notify: (latest) => {
        if (sdk) {
          Promise.resolve(
            sdk.Utils.showNotification({
              body: `Open ${instance.name} to update to the new version.`,
              title: `${instance.name} : Tofu ${latest} is available`,
            })
          ).catch(console.error);
        }
      },
      platform: process.platform,
      version,
    });
    resources.defer(() => updates.close());
    const sync = {
      adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
      principal: () => "local",
    };
    const publishChanges = createEngineChangePublisher(sync, engine);
    let timer: ReturnType<typeof setInterval> | null = null;
    let publishing: Promise<void> | null = null;
    let started = false;
    resources.defer(async () => {
      if (timer) {
        clearInterval(timer);
      }
      await publishing;
    });
    signal.throwIfAborted();
    const lifetime = resources.move();
    return {
      automation,
      close: () => lifetime.disposeAsync(),
      db,
      engine,
      instance,
      startBackground() {
        if (started) {
          return;
        }
        started = true;
        // External feeds are optional; their availability must not prevent local startup.
        void automation.start().catch(console.error);
        updates.start();
        timer = setInterval(() => {
          publishing ??= publishChanges()
            .catch(console.error)
            .finally(() => {
              publishing = null;
            });
        }, 1000);
        timer.unref();
      },
      sync,
      updates,
    };
  } catch (error) {
    try {
      await resources.disposeAsync();
    } catch (cleanupError) {
      // biome-ignore lint/style/useErrorCause: AggregateError takes ErrorOptions as its third argument and retains both errors.
      throw new AggregateError([error, cleanupError], "Application startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export function createEngineChangePublisher(
  options: SyncRuntimeOptions<TransactionalSyncAdapter<DatabaseTransaction, "sync">>,
  engine: Pick<EnginePort, "snapshot">
) {
  const fingerprint = () => {
    const { destinations, session, settings, torrents } = engine.snapshot(null, false);
    // History appends timestamped samples even while idle; current speeds are in the session.
    return JSON.stringify({ destinations, session, settings, torrents });
  };
  let previous = fingerprint();
  return async () => {
    const current = fingerprint();
    if (current === previous) {
      return;
    }
    await publishEngineChanges(options);
    previous = current;
  };
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
