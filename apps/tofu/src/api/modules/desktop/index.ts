import { on } from "node:events";
import { join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { desktopContext } from "@teyik0/furin-electrobun/server";
import { Context, Effect, Result } from "effect";
import { Elysia, ElysiaStatus, problem, sse } from "elysia";
import { config } from "../../../../evlog.config";
import { nativeControl } from "../../../native/control";
import { nativeServerActionSchema } from "../../../native/model";
import { sync } from "../../../sync";
import { instance } from "../../lib/instance";
import { services, servicesRuntime } from "../../lib/services-runtime";
import { StateJournals } from "../../lib/state-journals";
import { accessPlugin } from "../access/plugin";
import { acceptOpenedTorrentSchema } from "../torrents/model";
import { torrentServicePlugin } from "../torrents/plugin";
import { Updates } from "../updates/service";
import { setDefaultTorrentFileApp } from "./associations";
import { torrentOpenings } from "./service";

export const desktopPlugin = new Elysia({ name: "tofu-desktop-api" })
  .use(desktopContext)
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .decorate("updates", Context.get(services, Updates))
  .onStart(() => servicesRuntime.runPromise(Context.get(services, StateJournals).startRemote(sync)))
  // Host paths, native windows, dialogs and file openings belong to the host's own window.
  .guard({ idempotent: false, owner: true })
  .guard({
    beforeHandle({ desktop, path }) {
      const remoteThreads =
        path.startsWith("/api/desktop/servers/") && nativeControl.tofuNativeThreads;
      if (!(desktop || remoteThreads)) {
        return problem(409, { detail: "This action requires the desktop app" });
      }
    },
  })
  .get("/instance", () => instance)
  .get("/desktop/servers", () => {
    if (!nativeControl.tofuNativeServers) {
      return problem(409, { detail: "Desktop servers are managed in the native Tofu app" });
    }
    return nativeControl.tofuNativeServers.read();
  })
  .get("/desktop/servers/:id/threads", ({ params }) => {
    if (!nativeControl.tofuNativeThreads) {
      return problem(409, {
        detail: "Remote threads are available in the native Tofu app",
      });
    }
    return nativeControl.tofuNativeThreads.refresh(params.id);
  })
  .get("/desktop/servers/:id/state", ({ params }) => {
    if (!nativeControl.tofuNativeThreads) {
      return problem(409, {
        detail: "Remote threads are available in the native Tofu app",
      });
    }

    return nativeControl.tofuNativeThreads.snapshot(params.id);
  })
  .get("/desktop/servers/:id/threads/:threadId/torrents/:torrentId", ({ params, request }) => {
    if (!nativeControl.tofuNativeThreads) {
      return problem(409, {
        detail: "Remote torrents are available in the native Tofu app",
      });
    }
    return nativeControl.tofuNativeThreads.readTorrent(
      params.id,
      params.threadId,
      params.torrentId,
      request.signal
    );
  })
  .post("/desktop/servers", { body: nativeServerActionSchema }, async ({ body, desktop }) => {
    if (!(desktop && nativeControl.tofuNativeServers)) {
      return problem(409, { detail: "Desktop servers are managed in the native Tofu app" });
    }
    const result = await nativeControl.tofuNativeServers.run(body);
    if (!result.ok) {
      return problem(409, { detail: result.detail });
    }
    return result.state;
  })
  .post("/desktop/logs/open", async ({ desktop }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (!(desktop && sdk)) {
      return problem(409, { detail: "The logs folder is on the machine hosting Tofu" });
    }
    await config.drain.flush();
    return { opened: sdk.Utils.openPath(join(instance.dataDir, "logs")) };
  })
  .get("/desktop/openings", async function* ({ request }) {
    // Register before the first list so no torrent opened in between is missed.
    const changes = on(torrentOpenings.events, "change", { signal: request.signal });
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await changes.return?.();
    });
    for (;;) {
      yield sse({ data: torrentOpenings.list(), event: "openings" });
      // biome-ignore lint/performance/noAwaitInLoops: Each list follows the previous change.
      const next = await Effect.runPromise(
        Effect.result(Effect.tryPromise({ catch: (cause) => cause, try: () => changes.next() }))
      );
      if (Result.isFailure(next)) {
        if (request.signal.aborted) {
          return;
        }
        throw next.failure;
      }
      const { done } = next.success;
      if (done) {
        return;
      }
    }
  })
  .post(
    "/desktop/openings/:id",
    { body: acceptOpenedTorrentSchema },
    ({ torrents, params, body }) =>
      Effect.runPromise(torrentOpenings.accept(params.id, body, torrents))
  )
  .delete("/desktop/openings/:id", ({ params }) => torrentOpenings.dismiss(params.id))
  .post("/desktop/associations/torrent", ({ desktop }) => {
    if (!desktop) {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return setDefaultTorrentFileApp(instance.profile, desktop);
  })
  .post("/directory", async ({ desktop, torrents }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (!(desktop && sdk)) {
      return problem(409, { detail: "Enter the folder path on the server" });
    }
    const [path] = await sdk.Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: torrents.settings().downloadPath,
    });
    return { path: path ?? null };
  })
  .post("/torrents/:id/reveal", async ({ desktop, torrents, params }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (!(desktop && sdk)) {
      return problem(409, { detail: "The folder is on the machine hosting Tofu" });
    }
    const detail = await torrents.call("detail", [params.id]);
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    return { opened: sdk.Utils.openPath(detail.savePath) };
  })
  .post("/torrents/:id/files/:index/open", async ({ desktop, torrents, params }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (!(desktop && sdk)) {
      return problem(409, { detail: "The file is on the machine hosting Tofu" });
    }
    const file = await torrents.call("file", [params.id, Number(params.index)]);
    if (file instanceof ElysiaStatus) {
      return file;
    }
    return { opened: sdk.Utils.openPath(file.path) };
  })
  .get("/desktop", ({ desktop }) => {
    if (!desktop) {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    return desktop.snapshot();
  })
  .post("/desktop/open", ({ desktop }) => {
    if (!desktop) {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    desktop.open();
    return { ok: true };
  })
  .post("/desktop/background", ({ desktop, torrents }) => {
    if (!desktop) {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    if (!torrents.settings().runInBackground) {
      return problem(409, { detail: "Enable Run in background in settings first" });
    }
    if (!desktop.snapshot().trayVisible) {
      return problem(503, { detail: "The menu bar icon is unavailable; the window stays open" });
    }
    desktop.window?.close();
    return { ok: true };
  })
  .post("/updates/open-download", ({ desktop, updates }) => {
    if (!desktop) {
      return { opened: false };
    }
    if (updates.snapshot().status !== "available") {
      return problem(409, { detail: "No update available" });
    }
    return { opened: desktop.browser.open("/api/updates/download") };
  });
