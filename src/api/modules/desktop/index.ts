import { on } from "node:events";
import { join } from "node:path";
import { furinSync, invalidateSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem, sse } from "elysia";
import { createLogger } from "evlog";
import { nativeControl } from "../../../native/control";
import { nativeServerActionSchema } from "../../../native/model";
import { sync } from "../../../sync";
import { instance, logs } from "../../lib/database-plugin";
import { resources } from "../../lib/lifecycle-plugin";
import { runtime } from "../../lib/runtime";
import { accessPlugin } from "../access/plugin";
import { acceptOpenedTorrentSchema } from "../torrents/model";
import { torrentServicePlugin } from "../torrents/plugin";
import { updatesServicePlugin } from "../updates/plugin";
import { setDefaultTorrentFileApp } from "./associations";
import { torrentOpenings } from "./service";

let remoteStateChanges: ReturnType<typeof on> | null = null;

export const desktopPlugin = new Elysia({ name: "tofu-desktop-api" })
  .use(torrentServicePlugin)
  .use(updatesServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .onStart(() => {
    const remote = nativeControl.tofuNativeThreads;

    if (!remote || remoteStateChanges) {
      return;
    }

    const changes = on(remote, "change");
    remoteStateChanges = changes;

    const pending = new Map<string, { version: number; task: Promise<void> }>();
    let closing = false;

    const task = (async () => {
      for await (const [serverId] of changes) {
        if (closing || typeof serverId !== "string") {
          continue;
        }

        const existing = pending.get(serverId);
        if (existing) {
          existing.version += 1;
          continue;
        }

        const entry = { task: Promise.resolve(), version: 0 };
        pending.set(serverId, entry);
        entry.task = (async () => {
          let failures = 0;
          while (!closing) {
            const { version } = entry;
            try {
              // biome-ignore lint/performance/noAwaitInLoops: Each server retries its own invalidation after the previous attempt finishes.
              await invalidateSync(sync, "/api/desktop/servers/:id/state", { id: serverId });
              failures = 0;
              if (entry.version === version) {
                break;
              }
            } catch (cause) {
              const log = createLogger({
                component: "desktop-sync",
                context: { serverId },
                dataDir: instance.dataDir,
                error: cause,
                operation: "invalidate-remote-state",
              });
              log.setLevel("error");
              log.emit();
              const delay = Math.min(2000, 250 * 2 ** Math.min(failures, 3));
              failures += 1;
              await Bun.sleep(delay);
            }
          }
          pending.delete(serverId);
        })();
      }
    })();
    resources.defer(async () => {
      closing = true;
      await changes.return?.();
      await task;
      await Promise.all([...pending.values()].map((entry) => entry.task));
      remoteStateChanges = null;
    });
    resources.defer(remote.close.bind(remote));
    remote.start();
  })
  // Host paths, native windows, dialogs and file openings belong to the host's own window.
  .guard({ idempotent: false, owner: true })
  .get("/instance", () => instance)
  .get("/desktop/servers", () => {
    if (runtime.current.kind !== "desktop" || !nativeControl.tofuNativeServers) {
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
  .post("/desktop/servers", { body: nativeServerActionSchema }, async ({ body }) => {
    if (runtime.current.kind !== "desktop" || !nativeControl.tofuNativeServers) {
      return problem(409, { detail: "Desktop servers are managed in the native Tofu app" });
    }
    const result = await nativeControl.tofuNativeServers.run(body);
    if (!result.ok) {
      return problem(409, { detail: result.detail });
    }
    return result.state;
  })
  .post("/desktop/logs/open", async () => {
    const sdk = nativeControl.tofuNativeSdk;
    if (runtime.current.kind !== "desktop" || !sdk) {
      return problem(409, { detail: "The logs folder is on the machine hosting Tofu" });
    }
    await logs.flush();
    return { opened: sdk.Utils.openPath(join(instance.dataDir, "logs")) };
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
    const sdk = nativeControl.tofuNativeSdk;
    if (runtime.current.kind !== "desktop" || !sdk) {
      return problem(409, { detail: "Enter the folder path on the server" });
    }
    const [path] = await sdk.Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: torrents.settings.downloadPath,
    });
    return { path: path ?? null };
  })
  .post("/torrents/:id/reveal", async ({ torrents, params }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (runtime.current.kind !== "desktop" || !sdk) {
      return problem(409, { detail: "The folder is on the machine hosting Tofu" });
    }
    const detail = await torrents.detail(params.id);
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    return { opened: sdk.Utils.openPath(detail.savePath) };
  })
  .post("/torrents/:id/files/:index/open", async ({ torrents, params }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (runtime.current.kind !== "desktop" || !sdk) {
      return problem(409, { detail: "The file is on the machine hosting Tofu" });
    }
    const file = await torrents.file(params.id, Number(params.index));
    if (file instanceof ElysiaStatus) {
      return file;
    }
    return { opened: sdk.Utils.openPath(file.path) };
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
    runtime.current.desktop.open();
    return { ok: true };
  })
  .post("/desktop/background", ({ torrents }) => {
    if (runtime.current.kind !== "desktop") {
      return problem(409, { detail: "This action requires the desktop app" });
    }
    if (!torrents.settings.runInBackground) {
      return problem(409, { detail: "Enable Run in background in settings first" });
    }
    if (!runtime.current.desktop.snapshot().trayVisible) {
      return problem(503, { detail: "The menu bar icon is unavailable; the window stays open" });
    }
    runtime.current.desktop.window?.close();
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
