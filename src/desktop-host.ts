import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type DesktopAppModule,
  type DesktopBackend,
  getDesktopDevelopment,
  startDesktopBackend,
} from "@teyik0/furin-electrobun/host";
import { DesktopController } from "./server/desktop";
import { DesktopUrlOpener } from "./server/desktop-opening";
import { registerDesktopProtocol } from "./server/desktop-protocol";
import { writeServerInfo } from "./server/server-info";

process.env.TOFU_MODE = "desktop";
const sdk = await import("electrobun/main");
const development = await getDesktopDevelopment();
const { runtime, instance, getAutomation, getEngine, getDesktop, getUpdates } = await import(
  "./server/runtime"
);
runtime.sdk = sdk;
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
          error instanceof Error &&
          error.message === "AniList authorization was declined. Connect again when you are ready."
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
  sdk.default.events.on("open-url", (event: { data: { url: string } }) => openUrl(event.data.url));
  const initialUrl = process.env.TOFU_OPEN_URL;
  delete process.env.TOFU_OPEN_URL;
  if (initialUrl) {
    openUrl(initialUrl);
  }
  await registerDesktopProtocol(instance);
}

let module: DesktopAppModule | undefined;
let activeBackend: DesktopBackend | undefined;
const artifact = development?.serverEntry ?? join(import.meta.dir, "../furin/app.js");
try {
  const backend = await startDesktopBackend(
    async () => {
      module = (await import(pathToFileURL(artifact).href)) as DesktopAppModule;
      return module;
    },
    instance.dataDir,
    development ? "dev" : "build"
  );
  activeBackend = backend;
  await writeServerInfo(backend.origin, backend.cookie);
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
  runtime.desktop = new DesktopController({
    backend,
    checkUpdates: () => getUpdates().check(),
    engine: getEngine,
    name: instance.name,
    prepareUpdate: () => module?.onShutdown?.() ?? Promise.resolve(),
    profile: instance.profile,
    publicDir: development
      ? join(process.cwd(), "public")
      : join(import.meta.dir, "../furin/public"),
    recover: async () => {
      await module?.onStartup?.(new AbortController().signal);
      await writeServerInfo(backend.origin, backend.cookie);
    },
    sdk,
    shutdown: backend.stop,
    smokeScript,
  });
  opening?.ready();
  const shutdown = async () => {
    await backend.stop();
    sdk.Utils.quit(0);
  };
  await development?.ready(backend, shutdown);
  process.on("SIGINT", () => {
    shutdown().catch(console.error);
  });
  process.on("SIGTERM", () => {
    shutdown().catch(console.error);
  });
} catch (error) {
  console.error("Tofu desktop startup failed", error);
  try {
    await activeBackend?.stop();
  } finally {
    sdk.Utils.quit(1);
  }
}
