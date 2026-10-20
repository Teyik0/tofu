import { pathToFileURL } from "node:url";
import type { DesktopAppOptions } from "@teyik0/furin-electrobun/server";
import { ElysiaStatus } from "elysia";
import type { EnginePort } from "../../../types";
import { setDefaultTorrentApp } from "./associations";
import { TorrentOpenings } from "./opening";

export const desktopRuntime = { engine: undefined as EnginePort | undefined };
export const torrentOpenings = new TorrentOpenings();
export const desktopHooks = {
  background: () => desktopRuntime.engine?.settings.runInBackground === true,
  menus: ({ desktop, identity }) => [
    {
      label: identity.name,
      submenu: [
        { label: `About ${identity.name}`, role: "about" },
        ...(process.platform === "darwin" && identity.channel === "stable"
          ? [
              {
                label: "Set as default torrent app",
                onSelect: async () => {
                  try {
                    const { instance } = await import("../../lib/database-plugin");
                    const defaults = await setDefaultTorrentApp(instance.profile, desktop);
                    if (defaults instanceof ElysiaStatus) {
                      await desktop.dialogs.message({
                        detail: defaults.response.detail,
                        message: "Unable to change default torrent app",
                        title: identity.name,
                        type: "error",
                      });
                      return;
                    }
                    await desktop.dialogs.message({
                      detail: "Tofu will open .torrent files and magnet links.",
                      message: "Tofu is your default torrent app",
                      title: identity.name,
                      type: "info",
                    });
                  } catch (error) {
                    await desktop.dialogs.message({
                      detail: error instanceof Error ? error.message : "Unexpected error",
                      message: "Unable to change default torrent app",
                      title: identity.name,
                      type: "error",
                    });
                  }
                },
              },
            ]
          : []),
        { type: "divider" },
        {
          accelerator: "CmdOrCtrl+Q",
          label: `Quit ${identity.name}`,
          onSelect: () => desktop.quit(),
        },
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
  ],
  async onOpen({ event, desktop, identity }) {
    try {
      if (event.type === "url" && ["tofu:", "tofu-dev:"].includes(new URL(event.url).protocol)) {
        desktop.window.open();
        const { anilist } = await import("../anilist/plugin");
        await anilist.receiveAuthorizationUrl(event.url);
        return;
      }
      if (!desktopRuntime.engine) {
        throw new Error("The torrent engine is not ready");
      }
      const opened = await torrentOpenings.stage(
        event.type === "file" ? pathToFileURL(event.path).href : event.url,
        desktopRuntime.engine
      );
      desktop.window.open();
      if (opened instanceof ElysiaStatus) {
        await desktop.dialogs.message({
          detail: opened.response.detail,
          message: "Unable to open link",
          title: identity.name,
          type: "error",
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "AniList authorization was declined. Connect again when you are ready."
      ) {
        return;
      }
      await desktop.dialogs.message({
        detail: error instanceof Error ? error.message : "Unexpected error",
        message: "Unable to open link",
        title: identity.name,
        type: "error",
      });
    }
  },
  tray: ({ desktop }) => [
    { label: "Open Tofu", onSelect: () => desktop.window.open() },
    { label: "Open in browser", onSelect: () => desktop.browser.open("/") },
    { type: "divider" },
    {
      label: "Check for updates",
      onSelect: async () => {
        const { updates } = await import("../updates/plugin");
        await updates.check();
        desktop.window.open();
      },
    },
    { type: "divider" },
    { label: "Quit Tofu", onSelect: () => desktop.quit() },
  ],
} satisfies Pick<DesktopAppOptions, "background" | "onOpen" | "tray" | "menus">;
