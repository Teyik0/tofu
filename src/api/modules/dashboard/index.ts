import { furinSync } from "@teyik0/furin/sync";
import { desktopContext } from "@teyik0/furin-electrobun/server";
import { Context } from "effect";
import { Elysia, ElysiaStatus } from "elysia";
import { sync } from "../../../sync";
import { services, servicesRuntime } from "../../lib/services-runtime";
import { StateJournals } from "../../lib/state-journals";
import { accessPlugin } from "../access/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { dashboardQuerySchema } from "./model";
import { hostDetail, hostState, libraryState } from "./projection";

export const dashboardPlugin = new Elysia({ name: "tofu-dashboard-api" })
  .use(desktopContext)
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .onStart(() =>
    servicesRuntime.runPromise(Context.get(services, StateJournals).startWorkspace(sync))
  )
  .guard({ idempotent: false })
  .get(
    "/state",
    {
      playback: true,
      query: dashboardQuerySchema,
    },
    async ({ access, caller, desktop, torrents, query, set }) => {
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
          ? await torrents.call("detail", [selected])
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
                native: desktop !== null,
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
