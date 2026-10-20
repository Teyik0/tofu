import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { dashboardQuerySchema } from "./model";
import { hostState, libraryState } from "./projection";

export const dashboardPlugin = new Elysia({ name: "tofu-dashboard-api" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false })
  .get(
    "/state",
    {
      playback: true,
      query: dashboardQuerySchema,
    },
    async ({ access, torrents, query }) => {
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
      return libraryState(state, detail, { id: identity.serverId, name: identity.name });
    }
  )
  .get("/host", { administration: true }, async ({ torrents }) => {
    const state = await torrents.refreshSnapshot(1000);
    if (state instanceof ElysiaStatus) {
      return state;
    }
    return hostState(state);
  });
