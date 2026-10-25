import { dirname, join } from "node:path";
import { getDesktopDevelopment, getDesktopHost } from "@teyik0/furin-electrobun/host";
import { Effect } from "effect";
// biome-ignore lint/performance/noNamespaceImport: Share the canonical SDK with native integrations and the backend.
import * as sdk from "electrobun/main";
import { ElysiaStatus } from "elysia";
import { setDefaultTorrentApp } from "./api/modules/desktop/associations";
import { nativeControl } from "./native/control";
import "./native/host";

nativeControl.tofuNativeSdk = sdk;
if (!nativeControl.tofuNativeOpen) {
  throw new Error("The native link handler was not initialized");
}
sdk.default.events.on("open-url", nativeControl.tofuNativeOpen);
const development = await getDesktopDevelopment();
const identity = await sdk.Updater.getLocalInfo();
const items = [
  { action: "open", label: "Open Tofu", type: "normal" as const },
  { action: "servers", label: "Servers…", type: "normal" as const },
  { action: "browser", label: "Open in browser", type: "normal" as const },
  { type: "divider" as const },
  { action: "updates", label: "Check for updates", type: "normal" as const },
  { type: "divider" as const },
  { action: "quit", label: "Quit Tofu", type: "normal" as const },
];

sdk.ApplicationMenu.setApplicationMenu([
  {
    label: identity.name,
    submenu: [
      { label: `About ${identity.name}`, role: "about" },
      ...(identity.channel === "stable"
        ? [{ action: "associations", label: "Set as default torrent app" }]
        : []),
      { accelerator: "CmdOrCtrl+Shift+S", action: "servers", label: "Servers…" },
      ...items.filter((item) => item.action !== "servers" && item.action !== "quit"),
      { accelerator: "CmdOrCtrl+Q", action: "quit", label: "Quit Tofu" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);

// Native callbacks run outside HTTP and must observe their own failures.
async function dispatch(event: unknown) {
  if (
    !event ||
    typeof event !== "object" ||
    !("data" in event) ||
    !event.data ||
    typeof event.data !== "object" ||
    !("action" in event.data)
  ) {
    return;
  }
  try {
    const desktop = getDesktopHost();
    if (!desktop) {
      return;
    }
    switch (event.data.action) {
      case "open":
        desktop.open();
        break;
      case "servers":
        nativeControl.tofuNativeHost?.openConnections();
        break;
      case "browser":
        desktop.browser.open("/");
        break;
      case "updates":
        if (nativeControl.tofuNativeUpdates) {
          await Effect.runPromise(nativeControl.tofuNativeUpdates.check());
        }
        desktop.open();
        break;
      case "quit":
        await desktop.quit();
        break;
      case "associations": {
        const result = await setDefaultTorrentApp(
          identity.channel === "stable" ? "release" : "dev",
          desktop
        );
        await sdk.Utils.showMessageBox({
          detail:
            result instanceof ElysiaStatus
              ? result.response.detail
              : "Tofu will open .torrent files and magnet links.",
          message:
            result instanceof ElysiaStatus
              ? "Unable to change default torrent app"
              : "Tofu is your default torrent app",
          title: identity.name,
          type: result instanceof ElysiaStatus ? "error" : "info",
        });
        break;
      }
      default:
        break;
    }
  } catch (error) {
    await sdk.Utils.showMessageBox({
      detail: error instanceof Error ? error.message : "Unexpected error",
      message: "Unable to complete this action",
      title: identity.name,
      type: "error",
    });
  }
}

sdk.ApplicationMenu.on("application-menu-clicked", dispatch);
const mac = process.platform === "darwin";
const image = development
  ? join(development.root, "public", mac ? "tray-template.png" : "icon.png")
  : join(dirname(Bun.main), mac ? "tray-template.png" : "tray-icon.png");
const tray = new sdk.Tray({ height: 18, image, template: mac, width: 18 });
tray.setMenu(items);
tray.on("tray-clicked", dispatch);
