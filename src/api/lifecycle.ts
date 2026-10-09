import { version } from "../../package.json";
import { TorrentEngine } from "./engine";
import { readAniListClient } from "./feeds/anilist-client";
import { AutomationService } from "./feeds/service";
import { acquireInstance } from "./instance";
import { pluginEndpoints } from "./plugins/registry";
import { dataDir, getDesktop, getEngine, getNativeSdk, instance, runtime } from "./runtime";
import { createTofuSync } from "./sync";
import { UpdatesService } from "./updates";

export async function onStartup(signal: AbortSignal) {
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
  runtime.updates?.close();
  clearInterval(runtime.timer);
  await runtime.publishing;
  try {
    await runtime.automation?.close();
    await runtime.engine?.close();
  } finally {
    runtime.sync?.close();
    await runtime.lease?.close();
    runtime.engine = undefined;
    runtime.automation = undefined;
    runtime.sync = undefined;
    runtime.lease = undefined;
    runtime.updates = undefined;
  }
}

async function initialize(signal: AbortSignal) {
  const { desktop } = instance;
  const sdk = desktop ? getNativeSdk() : null;
  runtime.lease ??= await acquireInstance(instance);
  signal.throwIfAborted();
  runtime.sync ??= await createTofuSync(dataDir);
  signal.throwIfAborted();
  const { sync } = runtime;
  const engine =
    runtime.engine ??
    (await TorrentEngine.open({
      dataDir,
      downloadPath: instance.downloadPath,
      network: { maxConns: 100, userAgent: `Tofu/${version}`, utp: false },
    }));
  runtime.engine = engine;
  signal.throwIfAborted();
  const anilistClient = await readAniListClient(
    instance.profile,
    process.env.TOFU_ANILIST_CLIENT_ID,
    process.execPath
  );
  runtime.automation ??= await AutomationService.open({
    anilistClient,
    dataDir,
    endpoints: pluginEndpoints,
    engine: getEngine,
    now: Date.now,
  });
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
      runtime.publishing = sync
        .publish()
        .catch(console.error)
        .finally(() => {
          runtime.publishing = undefined;
        });
    }
  }, 1000);
  runtime.timer.unref();
}
