import { on } from "node:events";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, problem, sse } from "elysia";
import { sync } from "../../../sync";
import { instance, logs } from "../../lib/database-plugin";
import { runtime } from "../../lib/runtime";
import { acceptOpenedTorrentSchema } from "../torrents/model";
import { torrentServicePlugin } from "../torrents/plugin";
import { updatesServicePlugin } from "../updates/plugin";
import { setDefaultTorrentFileApp } from "./associations";
import { torrentOpenings } from "./service";

export const desktopPlugin = new Elysia({ name: "tofu-desktop-api" })
  .use(torrentServicePlugin)
  .use(updatesServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/instance", () => instance)
  .post("/desktop/logs/open", async () => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "The logs folder is on the machine hosting Tofu" });
    }
    await logs.flush();
    return { opened: runtime.current.desktop.shell.openPath(logs.directory) };
  })
  .get("/desktop/openings", async function* ({ request }) {
    // Register before the first list so no torrent opened in between is missed.
    const changes = on(torrentOpenings, "change", { signal: request.signal });
    try {
      for (;;) {
        yield sse({ data: torrentOpenings.list(), event: "openings" });
        // biome-ignore lint/performance/noAwaitInLoops: Each list follows the previous change.
        const { done } = await changes.next();
        if (done) {
          return;
        }
      }
    } catch (error) {
      // A closed window aborts the pending change iterator.
      if (!request.signal.aborted) {
        throw error;
      }
    } finally {
      await changes.return?.();
    }
  })
  .post(
    "/desktop/openings/:id",
    { body: acceptOpenedTorrentSchema },
    ({ torrents, params, body }) => torrentOpenings.accept(params.id, body, torrents)
  )
  .delete("/desktop/openings/:id", ({ params }) => torrentOpenings.dismiss(params.id))
  .post("/desktop/associations/torrent", () => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return setDefaultTorrentFileApp(instance.profile, runtime.current.desktop);
  })
  .post("/directory", async ({ torrents }) => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "Enter the folder path on the server" });
    }
    const path = await runtime.current.desktop.dialogs.selectDirectory({
      startingFolder: torrents.settings.downloadPath,
    });
    return { path };
  })
  .post("/torrents/:id/reveal", async ({ torrents, params }) => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "The folder is on the machine hosting Tofu" });
    }
    return {
      opened: runtime.current.desktop.shell.openPath((await torrents.detail(params.id)).savePath),
    };
  })
  .get("/desktop", () => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return runtime.current.desktop.snapshot();
  })
  .post("/desktop/open", () => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return runtime.current.desktop.window.open();
  })
  .post("/desktop/background", async ({ torrents }) => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    if (!torrents.settings.runInBackground) {
      return problem(409, { detail: "Enable Run in background in settings first" });
    }
    if (!runtime.current.desktop.snapshot().trayVisible) {
      return problem(503, { detail: "The menu bar icon is unavailable; the window stays open" });
    }
    await runtime.current.desktop.window.background();
    return { ok: true };
  })
  .post("/updates/open-download", ({ updates }) => {
    if (runtime.current.kind !== "desktop") {
      return { opened: false };
    }
    if (updates.snapshot().status !== "available") {
      return problem(409, { detail: "No update available" });
    }
    return { opened: runtime.current.desktop.browser.open("/api/updates/download") };
  });
