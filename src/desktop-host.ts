import { join } from "node:path";
import { runDesktopHost } from "@teyik0/furin-electrobun/host";
import { writeServerInfo } from "./api/lib/server-info";
import { DesktopUrlOpener } from "./api/modules/desktop/opening";
import { registerDesktopProtocol } from "./api/modules/desktop/protocol";
import { DesktopController } from "./api/modules/desktop/service";

process.env.TOFU_MODE = "desktop";
const sdk = await import("electrobun/main");

await runDesktopHost(sdk, async ({ startBackend }) => {
  const { runtime, instance, getAutomation, getDesktop, getUpdates } = await import(
    "./api/lib/runtime"
  );
  const { services } = await import("./api/lib/services");
  runtime.sdk = sdk;
  const opening = sdk
    ? new DesktopUrlOpener({
        authorize: (callbackUrl) => getAutomation().anilist.receiveAuthorizationUrl(callbackUrl),
        engine: () => services.engine,
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

  const { onStartup, onShutdown } = await import("./api/lib/lifecycle");
  const { backend } = await startBackend({ dataDir: instance.dataDir });
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
    void import("./api/modules/desktop/associations")
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
    engine: () => services.engine,
    name: instance.name,
    prepareUpdate: onShutdown,
    profile: instance.profile,
    publicDir: process.env.FURIN_DESKTOP_DEV
      ? join(process.cwd(), "public")
      : join(import.meta.dir, "../furin/public"),
    recover: async () => {
      await onStartup(new AbortController().signal);
      await writeServerInfo(backend.origin, backend.cookie);
    },
    sdk,
    shutdown: backend.stop,
    smokeScript,
  });
  opening?.ready();
});
