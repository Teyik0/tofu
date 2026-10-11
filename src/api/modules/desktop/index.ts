import { furinSync } from "@teyik0/furin/sync";
import { Elysia, problem } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";

import { setDefaultTorrentFileApp } from "./associations";

export const desktopPlugin = new Elysia({ name: "tofu-desktop-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/instance", ({ application }) => application.instance)
  .post("/desktop/associations/torrent", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return setDefaultTorrentFileApp(application.instance.profile, application.platform.desktop);
  })
  .post("/directory", async ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "Enter the folder path on the server" });
    }
    const path = await application.platform.desktop.dialogs.selectDirectory({
      startingFolder: application.engine.settings.downloadPath,
    });
    return { path };
  })
  .post("/torrents/:id/reveal", async ({ application, params }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "The folder is on the machine hosting Tofu" });
    }
    return {
      opened: application.platform.desktop.shell.openPath(
        (await application.engine.detail(params.id)).savePath
      ),
    };
  })
  .get("/desktop", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return application.platform.desktop.snapshot();
  })
  .post("/desktop/open", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return application.platform.desktop.window.open();
  })
  .post("/desktop/background", async ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    if (!application.engine.settings.runInBackground) {
      return problem(409, { detail: "Enable Run in background in settings first" });
    }
    if (!application.platform.desktop.snapshot().trayVisible) {
      return problem(503, { detail: "The menu bar icon is unavailable; the window stays open" });
    }
    await application.platform.desktop.window.background();
    return { ok: true };
  })
  .post("/updates/open-download", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return { opened: false };
    }
    if (application.updates.snapshot().status !== "available") {
      return problem(409, { detail: "No update available" });
    }
    return { opened: application.platform.desktop.browser.open("/api/updates/download") };
  });
