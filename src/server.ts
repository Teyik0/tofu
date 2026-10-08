import { furin } from "@teyik0/furin";
import { createDesktopApp } from "@teyik0/furin-electrobun/server";
import { version } from "../package.json";
import { createApi } from "./server/api";
import { TorrentEngine, UserError } from "./server/engine";
import { readAniListClient } from "./server/feeds/anilist-client";
import { createAniListOpeningApi } from "./server/feeds/anilist-opening-api";
import { AutomationService } from "./server/feeds/service";
import { acquireInstance } from "./server/instance";
import { pluginEndpoints } from "./server/plugins/registry";
import { createRequestGuard } from "./server/request-guard";
import {
  dataDir,
  getAutomation,
  getDesktop,
  getEngine,
  getNativeSdk,
  getUpdates,
  instance,
  runtime,
  syncOptions,
} from "./server/runtime";
import { writeServerInfo } from "./server/server-info";
import { createTofuSync } from "./server/sync";
import { UpdatesService } from "./server/updates";

let { engine } = runtime;
let closing = false;

const app = createDesktopApp()
  .use(createRequestGuard())
  .use(
    createApi(getEngine, syncOptions, getAutomation, { desktop: getDesktop, updates: getUpdates })
  )
  .get("/api/instance", () => instance)
  .use(
    createAniListOpeningApi({
      isDesktop: () => getEngine().mode === "desktop",
      openExternal: (url) => {
        const { Utils } = getNativeSdk();
        return Promise.resolve(Utils.openExternal(url));
      },
    })
  )
  .post("/api/directory", { sync: false }, async () => {
    if (getEngine().mode !== "desktop") {
      throw new UserError("Enter the folder path on the server", { status: 409 });
    }
    const { Utils } = getNativeSdk();
    const paths = await Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: getEngine().settings.downloadPath,
    });
    return { path: paths[0] ?? null };
  })
  .post("/api/torrents/:id/reveal", { sync: false }, ({ params }) => {
    if (getEngine().mode !== "desktop") {
      throw new UserError("The folder is on the machine hosting Tofu", { status: 409 });
    }
    const { Utils } = getNativeSdk();
    return { opened: Utils.openPath(getEngine().get(params.id).detail.savePath) };
  })
  .use(await furin({ pagesDir: "./src/pages", sync: syncOptions }));

export default app;

export async function onStartup(signal: AbortSignal) {
  closing = false;
  try {
    signal.throwIfAborted();
    await initialize(signal);
    signal.throwIfAborted();
  } catch (error) {
    closing = false;
    await onShutdown();
    throw error;
  }
}

export async function onShutdown() {
  if (closing) {
    return;
  }
  closing = true;
  runtime.updates?.close();
  clearInterval(runtime.timer);
  await runtime.publishing;
  try {
    await runtime.automation?.close();
    await engine?.close();
  } finally {
    runtime.sync?.close();
    await runtime.lease?.close();
    runtime.engine = undefined;
    engine = undefined;
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
  engine =
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

export async function startServer() {
  try {
    await onStartup(new AbortController().signal);
    app.listen({ hostname: "127.0.0.1", maxRequestBodySize: 9 * 1024 * 1024, port: instance.port });
    const url = `http://127.0.0.1:${app.server?.port}`;
    await writeServerInfo(url, undefined);
    const shutdown = async () => {
      await app.stop(true);
      await onShutdown();
      process.exit(0);
    };
    if (runtime.shutdown) {
      process.off("SIGINT", runtime.shutdown);
      process.off("SIGTERM", runtime.shutdown);
    }
    runtime.shutdown = shutdown;
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    await onShutdown();
    throw error;
  }
}
