import { join } from "node:path";
import { runDesktopHost } from "@teyik0/furin-electrobun/host";
import { writeServerInfo } from "./api/lib/server-info";
import { desktopHostSdk } from "./api/modules/desktop/host-sdk";
import { DesktopUrlOpener } from "./api/modules/desktop/opening";
import { registerDesktopProtocol } from "./api/modules/desktop/protocol";
import { DesktopController } from "./api/modules/desktop/service";

process.env.TOFU_MODE = "desktop";
const sdk = await import("electrobun/main");

await runDesktopHost(desktopHostSdk(sdk), async ({ startBackend }) => {
  const { applicationHost, hostIntegration, instance } = await import("./api/lib/host");
  hostIntegration.tofuNativeSdk = sdk;
  const readiness = Promise.withResolvers<DesktopUrlOpener>();
  {
    const openUrl = (callbackUrl: string) => {
      void readiness.promise
        .then((opener) => opener.open(callbackUrl))
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
  let core = await applicationHost.core;
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
  const desktop = new DesktopController({
    backend,
    checkUpdates: () => core.updates.check(),
    engine: () => core.engine,
    name: instance.name,
    prepareUpdate: onShutdown,
    profile: instance.profile,
    publicDir: process.env.FURIN_DESKTOP_DEV
      ? join(process.cwd(), "public")
      : join(import.meta.dir, "../furin/public"),
    recover: async () => {
      await onStartup(new AbortController().signal);
      core = await applicationHost.core;
      applicationHost.activate(core, { controller: desktop, kind: "desktop", utils: sdk.Utils });
      await writeServerInfo(core, backend.origin, backend.cookie);
    },
    sdk,
    shutdown: backend.stop,
    smokeScript,
  });
  applicationHost.activate(core, { controller: desktop, kind: "desktop", utils: sdk.Utils });
  await writeServerInfo(core, backend.origin, backend.cookie);
  const opening = new DesktopUrlOpener({
    authorize: (url) => core.automation.anilist.receiveAuthorizationUrl(url),
    engine: () => core.engine,
    show: () => {
      desktop.open();
    },
  });
  opening.ready();
  readiness.resolve(opening);
  desktop.open();
});
