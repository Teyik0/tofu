import { homedir } from "node:os";
import { join } from "node:path";
import { furin } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { version } from "../package.json";
import { createApi } from "./server/api";
import { TorrentEngine, UserError } from "./server/engine";
import { AutomationService } from "./server/feeds/service";
import { pluginEndpoints } from "./server/plugins/registry";
import {
  dataDir,
  getAutomation,
  getDesktop,
  getEngine,
  getUpdates,
  runtime,
  sync,
} from "./server/runtime";
import { UpdatesService } from "./server/updates";

let { engine } = runtime;
let closing = false;

const app = new Elysia()
  .use(
    createApi(getEngine, sync.options, getAutomation, { desktop: getDesktop, updates: getUpdates })
  )
  .post(
    "/api/anilist/open",
    { body: t.Object({ url: t.String({ maxLength: 2000 }) }), sync: false },
    async ({ body }) => {
      const url = new URL(body.url);
      if (url.origin !== "https://anilist.co" || url.pathname !== "/api/v2/oauth/authorize") {
        throw new UserError("URL de connexion AniList invalide", { status: 400 });
      }
      if (getEngine().mode !== "desktop") {
        return { opened: false, url: url.href };
      }
      const { Utils } = await import("electrobun/main");
      return { opened: Utils.openExternal(url.href), url: url.href };
    }
  )
  .post("/api/directory", { sync: false }, async () => {
    if (getEngine().mode !== "desktop") {
      throw new UserError("Saisissez le chemin du dossier sur le serveur", { status: 409 });
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
      throw new UserError("Le dossier se trouve sur la machine qui héberge Tofu", { status: 409 });
    }
    const { Utils } = await import("electrobun/main");
    return { opened: Utils.openPath(getEngine().get(params.id).detail.savePath) };
  })
  .use(await furin({ pagesDir: "./src/pages", sync: sync.options }));

export default app;

export async function startServer() {
  const desktop =
    process.env.TOFU_MODE === "desktop" || process.execPath.includes(".app/Contents/MacOS/");
  engine =
    runtime.engine ??
    (await TorrentEngine.open({
      dataDir,
      downloadPath: process.env.TOFU_DOWNLOAD_DIR ?? join(homedir(), "Downloads/Tofu"),
      network: { maxConns: 100, userAgent: `Tofu/${version}`, utp: false },
    }));
  runtime.engine = engine;
  runtime.automation ??= await AutomationService.open({
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
    notify: (latest) => {
      if (desktop) {
        void import("electrobun/main")
          .then(({ Utils }) =>
            Utils.showNotification({
              body: "Ouvrez Tofu pour télécharger la nouvelle version.",
              title: `Tofu ${latest} est disponible`,
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
    port: Number(process.env.TOFU_PORT ?? (desktop ? "0" : "3030")),
  });
  const url = `http://127.0.0.1:${app.server?.port}`;
  await Bun.write(
    join(dataDir, "server.json"),
    JSON.stringify({ mode: engine.mode, pid: process.pid, url })
  );
  console.log(`Tofu est prêt : ${url}`);
  const dispose = async () => {
    if (closing) {
      return;
    }
    closing = true;
    runtime.updates?.close();
    clearInterval(runtime.timer);
    app.server?.stop(true);
    await runtime.publishing;
    await runtime.automation?.close();
    await engine?.close();
    sync.close();
  };
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
  if (!desktop) {
    return;
  }
  const sdk = await import("electrobun/main");
  const { ApplicationMenu } = sdk;
  ApplicationMenu.setApplicationMenu([
    {
      label: "Tofu",
      submenu: [
        { label: "À propos de Tofu", role: "about" },
        { type: "divider" },
        { accelerator: "CmdOrCtrl+Q", label: "Quitter Tofu", role: "quit" },
      ],
    },
    {
      label: "Édition",
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
  const smokeScript = process.env.TOFU_SMOKE_SCRIPT
    ? await Bun.file(process.env.TOFU_SMOKE_SCRIPT).text()
    : null;
  const { DesktopController } = await import("./server/desktop");
  runtime.desktop ??= new DesktopController({
    checkUpdates: () => getUpdates().check(),
    engine: getEngine,
    sdk,
    shutdown: dispose,
    smokeScript,
    url,
  });
  return runtime.desktop;
}
