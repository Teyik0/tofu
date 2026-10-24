import { furinSync, invalidateSync } from "@teyik0/furin/sync";
import { createContext, Elysia, ElysiaStatus } from "elysia";
import { createLogger } from "evlog";
import { sync } from "../../../sync";
import { instance } from "../../lib/instance";
import { runtime } from "../../lib/runtime";
import { accessPlugin } from "../access/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { dashboardQuerySchema } from "./model";
import { hostDetail, hostState, libraryState } from "./projection";

const workspaceSync = {
  revision: 0,
  wake: Promise.withResolvers<void>(),
};

export const dashboardPlugin = new Elysia({ name: "tofu-dashboard-api" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .use((app) => {
    const { torrents, resources } = createContext(app).prototype;
    let closing = false;
    const changed = () => {
      workspaceSync.revision += 1;
      workspaceSync.wake.resolve();
    };
    torrents.on("change", changed);
    // biome-ignore-start lint/performance/noAwaitInLoops: Journal writes and their retries must stay ordered.
    const task = (async () => {
      while (!closing) {
        await workspaceSync.wake.promise;
        workspaceSync.wake = Promise.withResolvers<void>();
        let published = -1;
        let failures = 0;
        while (!closing && published !== workspaceSync.revision) {
          const { revision } = workspaceSync;
          try {
            await invalidateSync(sync, "/api/state");
            published = revision;
            failures = 0;
          } catch (error) {
            // This background journal write has no request to report its I/O failure.
            const log = createLogger({
              component: "torrent-sync",
              dataDir: instance.dataDir,
              error,
              operation: "invalidate-state",
            });
            log.setLevel("error");
            log.emit();
            await Bun.sleep(Math.min(2000, 250 * 2 ** Math.min(failures, 3)));
            failures += 1;
          }
        }
      }
    })();
    // biome-ignore-end lint/performance/noAwaitInLoops: Journal writes and their retries must stay ordered.
    resources.defer(async () => {
      closing = true;
      torrents.off("change", changed);
      workspaceSync.wake.resolve();
      await task;
    });
    return app;
  })
  .guard({ idempotent: false })
  .get(
    "/state",
    {
      playback: true,
      query: dashboardQuerySchema,
    },
    async ({ access, caller, torrents, query, set }) => {
      set.headers["cache-control"] = "private, no-store";
      const state = await torrents.refreshSnapshot(1000);
      if (state instanceof ElysiaStatus) {
        return state;
      }
      const selected = query.selected ?? state.torrents[0]?.id;
      const detail =
        query.detail !== "false" &&
        selected &&
        state.torrents.some((torrent) => torrent.id === selected)
          ? await torrents.detail(selected)
          : null;
      const identity = access.identity();
      if (detail instanceof ElysiaStatus) {
        return detail;
      }
      const host =
        caller.kind === "owner" ||
        (caller.kind === "device" && caller.device.role === "administration");
      return {
        ...libraryState(state, detail, { id: identity.serverId, name: identity.name }),
        detailHost: host && detail ? hostDetail(detail) : null,
        host: host ? hostState(state) : null,
        viewer:
          caller.kind === "in-process"
            ? null
            : access.sessionView(caller, {
                native: runtime.current.kind === "desktop",
                remoteAccess: access.policy().enabled,
              }),
      };
    }
  )
  .get("/host", { administration: true }, async ({ torrents }) => {
    const state = await torrents.refreshSnapshot(1000);
    if (state instanceof ElysiaStatus) {
      return state;
    }
    return hostState(state);
  });
