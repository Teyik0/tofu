import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import {
  type DesktopBackend,
  type DesktopCapabilities,
  getDesktopDevelopment,
  type ReadyContext,
  type StartupContext,
} from "@teyik0/furin-electrobun/host";
import { version } from "../../../package.json";
import type { CoreApplication } from "../../types";
import { readAniListClient } from "../modules/anilist/client";
import { AutomationService } from "../modules/automation/service";
import { pluginEndpoints } from "../modules/plugins/service";
import { WorkerTorrentEngine } from "../modules/torrents/worker-client";
import { UpdatesService } from "../modules/updates/service";
import { assertDatabaseReady, openDatabase } from "./db";
import { applicationHost } from "./host";
import { acquireInstance, currentInstanceConfig } from "./instance";
import { writeServerInfo } from "./server-info";
import { ObservedSyncNotifier } from "./sync-notifier";

// Update recovery replaces application resources, while the native supervisor stays alive.
const developmentHosts = new WeakSet<DesktopCapabilities>();

export async function assertApplicationReady(application: Pick<CoreApplication, "db" | "engine">) {
  assertDatabaseReady(application.db);
  await application.engine.assertReady();
}

export async function onStartup(context: StartupContext) {
  await applicationHost.prepare(
    (signal) => openCoreApplication({ ...context, signal }),
    context.signal
  );
}

export async function onReady({ runtime, backend }: ReadyContext) {
  const core = await applicationHost.core;
  applicationHost.activate(core, runtime);
  await writeServerInfo(core, backend.origin, backend.cookie);
  if (
    runtime.kind === "desktop" &&
    process.env.FURIN_DESKTOP_DEV &&
    !developmentHosts.has(runtime.desktop)
  ) {
    const development = await getDesktopDevelopment();
    // The runtime passes its backend; ReadyContext exposes only its trusted session fields.
    if (
      !(
        "bootstrapOrigin" in backend &&
        typeof backend.bootstrapOrigin === "string" &&
        "createWindowUrl" in backend &&
        typeof backend.createWindowUrl === "function" &&
        "stop" in backend &&
        typeof backend.stop === "function" &&
        "url" in backend &&
        typeof backend.url === "string" &&
        typeof backend.cookie === "string"
      )
    ) {
      throw new Error("Furin development requires the desktop backend capabilities");
    }
    await development?.ready(backend as DesktopBackend, () => runtime.desktop.quit());
    developmentHosts.add(runtime.desktop);
  }
}

export function onShutdown() {
  return applicationHost.stop();
}

export async function openCoreApplication({
  signal,
  runtime,
}: StartupContext): Promise<CoreApplication> {
  const resources = new AsyncDisposableStack();
  try {
    signal.throwIfAborted();
    const instance = await currentInstanceConfig(runtime);
    const lease = await acquireInstance(instance);
    resources.defer(() => lease.close());
    signal.throwIfAborted();
    const db = await openDatabase(instance.dataDir);
    resources.defer(() => db.$client.close(true));
    assertDatabaseReady(db);
    signal.throwIfAborted();
    const engine = await WorkerTorrentEngine.open({
      dataDir: instance.dataDir,
      downloadPath: instance.downloadPath,
      network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
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
        runtime.kind === "desktop" && instance.profile === "release"
          ? runtime.desktop.updates
          : undefined,
      notify: (latest) => {
        if (runtime.kind === "desktop") {
          runtime.desktop.notifications.show({
            body: `Open ${instance.name} to update to the new version.`,
            title: `${instance.name} : Tofu ${latest} is available`,
          });
        }
      },
      platform: process.platform,
      version,
    });
    resources.defer(() => updates.close());
    const adapter = drizzleSyncAdapter({ db, namespace: "tofu" });
    const notifier = new ObservedSyncNotifier(engine.setObserved.bind(engine));
    const sync = { adapter, notifier, principal: () => "local" };
    const unsubscribe: () => void = engine.subscribeChanges(({ cursor }) => {
      if (cursor !== undefined) {
        void notifier.publish(cursor).catch(console.error);
      }
    });
    resources.defer(unsubscribe);
    let started = false;
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
