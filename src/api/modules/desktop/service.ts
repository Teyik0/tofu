import { pathToFileURL } from "node:url";
import type { DesktopAppOptions } from "@teyik0/furin-electrobun/server";
import { Elysia, ElysiaStatus } from "elysia";
import { instance } from "../../lib/database-plugin";
import { anilistServicePlugin } from "../anilist/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { updatesServicePlugin } from "../updates/plugin";
import { setDefaultTorrentApp } from "./associations";
import { TorrentOpenings } from "./opening";

export const torrentOpenings = new TorrentOpenings();
export const desktopServicePlugin = new Elysia({ name: "tofu-desktop-service" })
  .use(anilistServicePlugin)
  .use(torrentServicePlugin)
  .use(updatesServicePlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    desktopHooks: {
      background: () => dependencies.torrents.settings.runInBackground === true,
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
          if (
            event.type === "url" &&
            ["tofu:", "tofu-dev:"].includes(new URL(event.url).protocol)
          ) {
            desktop.window.open();
            const result = await dependencies.anilist.receiveAuthorizationUrl(event.url);
            if (result instanceof ElysiaStatus) {
              await desktop.dialogs.message({
                detail: result.response.detail,
                message: "Unable to open link",
                title: identity.name,
                type: "error",
              });
            }
            return;
          }
          const opened = await torrentOpenings.stage(
            event.type === "file" ? pathToFileURL(event.path).href : event.url,
            dependencies.torrents
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
            error.message ===
              "AniList authorization was declined. Connect again when you are ready."
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
            await dependencies.updates.check();
            desktop.window.open();
          },
        },
        { type: "divider" },
        { label: "Quit Tofu", onSelect: () => desktop.quit() },
      ],
    } satisfies Pick<DesktopAppOptions, "background" | "onOpen" | "tray" | "menus">,
  }));
