import { rename } from "node:fs/promises";
import { join } from "node:path";
import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { version } from "../package.json";
import { createApi } from "./server/api";
import { DesktopUrlOpener } from "./server/desktop-opening";
import { registerDesktopProtocol } from "./server/desktop-protocol";
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
  getUpdates,
  instance,
  runtime,
  syncOptions,
} from "./server/runtime";
import { createTofuSync } from "./server/sync";
import { UpdatesService } from "./server/updates";

let { engine } = runtime;
let closing = false;

const app = new Elysia()
  .use(createRequestGuard())
  .use(
    createApi(getEngine, syncOptions, getAutomation, { desktop: getDesktop, updates: getUpdates })
  )
  .get("/api/instance", () => instance)
  .use(
    createAniListOpeningApi({
      isDesktop: () => getEngine().mode === "desktop",
      openExternal: async (url) => {
        const { Utils } = await import("electrobun/main");
        return Utils.openExternal(url);
      },
    })
  )
  .post("/api/directory", { sync: false }, async () => {
    if (getEngine().mode !== "desktop") {
      throw new UserError("Enter the folder path on the server", { status: 409 });
    }
    const { Utils } = await import("electrobun/main");
    const paths = await Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: getEngine().settings.downloadPath,
    });
    return { path: paths[0] ?? null };
  })
  .post("/api/torrents/:id/reveal", { sync: false }, async ({ params }) => {
    if (getEngine().mode !== "desktop") {
      throw new UserError("The folder is on the machine hosting Tofu", { status: 409 });
    }
    const { Utils } = await import("electrobun/main");
    return { opened: Utils.openPath(getEngine().get(params.id).detail.savePath) };
  })
  .use(await furin({ pagesDir: "./src/pages", sync: syncOptions }));

export default app;

export async function startServer() {
  try {
    return await launchServer();
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function dispose() {
  if (closing) {
    return;
  }
  closing = true;
  runtime.updates?.close();
  clearInterval(runtime.timer);
  app.server?.stop(true);
  await runtime.publishing;
  try {
    await runtime.automation?.close();
    await engine?.close();
  } finally {
    runtime.sync?.close();
    await runtime.lease?.close();
  }
}

async function launchServer() {
  const { desktop } = instance;
  const sdk = desktop ? await import("electrobun/main") : null;
  const opening = sdk
    ? new DesktopUrlOpener({
        authorize: (callbackUrl) => getAutomation().anilist.receiveAuthorizationUrl(callbackUrl),
        engine: getEngine,
        show: () => {
          getDesktop().open();
        },
      })
    : null;
  if (sdk && opening && !runtime.desktop) {
    const openUrl = (callbackUrl: string) => {
      void opening
        .open(callbackUrl)
        .catch((error: unknown) => {
          if (
            error instanceof UserError &&
            error.message ===
              "AniList authorization was declined. Connect again when you are ready."
          ) {
            return;
          }
          console.error("Unable to open link");
          return sdk.Utils.showMessageBox({
            detail: error instanceof Error ? error.message : "Unexpected error",
            message: "Unable to open link",
            title: instance.name,
            type: "error",
          });
        })
        .catch(console.error);
    };
    sdk.default.events.on("open-url", (event: { data: { url: string } }) =>
      openUrl(event.data.url)
    );
    const initialUrl = process.env.TOFU_OPEN_URL;
    delete process.env.TOFU_OPEN_URL;
    if (initialUrl) {
      openUrl(initialUrl);
    }
    await registerDesktopProtocol(instance);
  }
  runtime.lease ??= await acquireInstance(instance);
  runtime.sync ??= await createTofuSync(dataDir);
  const { sync } = runtime;
  engine =
    runtime.engine ??
    (await TorrentEngine.open({
      dataDir,
      downloadPath: instance.downloadPath,
      network: { maxConns: 100, userAgent: `Tofu/${version}`, utp: false },
    }));
  runtime.engine = engine;
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
        void import("electrobun/main")
          .then(({ Utils }) =>
            Utils.showNotification({
              body: `Open ${instance.name} to update to the new version.`,
              title: `${instance.name} : Tofu ${latest} is available`,
            })
          )
          .catch(console.error);
      }
    },
    platform: process.platform,
    version,
  });
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
  app.listen({
    hostname: "127.0.0.1",
    maxRequestBodySize: 9 * 1024 * 1024,
    port: instance.port,
  });
  const url = `http://127.0.0.1:${app.server?.port}`;
  await Bun.write(
    join(dataDir, "server.json.tmp"),
    JSON.stringify({ mode: engine.mode, pid: process.pid, profile: instance.profile, url }),
    { mode: 0o600 }
  );
  await rename(join(dataDir, "server.json.tmp"), join(dataDir, "server.json"));
  console.log(`${instance.name} is ready : ${url} (data: ${dataDir})`);
  const shutdown = async () => {
    await dispose();
    process.exit(0);
  };
  if (runtime.shutdown) {
    process.off("SIGINT", runtime.shutdown);
    process.off("SIGTERM", runtime.shutdown);
  }
  runtime.shutdown = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (!sdk) {
    return;
  }
  if (runtime.desktop) {
    return runtime.desktop;
  }
  const { ApplicationMenu } = sdk;
  ApplicationMenu.setApplicationMenu([
    {
      label: instance.name,
      submenu: [
        { label: `About ${instance.name}`, role: "about" },
        ...(process.platform === "darwin" && instance.profile === "release"
          ? [{ action: "set-default-torrent-app", label: "Set as default torrent app" }]
          : []),
        { type: "divider" },
        { accelerator: "CmdOrCtrl+Q", label: `Quit ${instance.name}`, role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);
  ApplicationMenu.on("application-menu-clicked", (event) => {
    if ((event as { data: { action: string } }).data.action !== "set-default-torrent-app") {
      return;
    }
    void import("./server/desktop-associations")
      .then(({ setDefaultTorrentApp }) => setDefaultTorrentApp(instance.profile))
      .then(() =>
        sdk.Utils.showMessageBox({
          detail: "Tofu will open .torrent files and magnet links.",
          message: "Tofu is your default torrent app",
          title: instance.name,
          type: "info",
        })
      )
      .catch((error: unknown) =>
        sdk.Utils.showMessageBox({
          detail: error instanceof Error ? error.message : "Unexpected error",
          message: "Unable to change default torrent app",
          title: instance.name,
          type: "error",
        })
      )
      .catch(console.error);
  });
  const smokeScript = process.env.TOFU_SMOKE_SCRIPT
    ? await Bun.file(process.env.TOFU_SMOKE_SCRIPT).text()
    : null;
  const { DesktopController } = await import("./server/desktop");
  runtime.desktop ??= new DesktopController({
    checkUpdates: () => getUpdates().check(),
    engine: getEngine,
    name: instance.name,
    profile: instance.profile,
    recover: async () => {
      runtime.engine = undefined;
      engine = undefined;
      runtime.automation = undefined;
      runtime.sync = undefined;
      runtime.lease = undefined;
      closing = false;
      await launchServer();
    },
    sdk,
    shutdown: dispose,
    smokeScript,
    url,
  });
  opening?.ready();
  return runtime.desktop;
}
