import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { torrentServicePlugin } from "../torrents/plugin";
import { dashboardQuerySchema } from "./model";

export const dashboardPlugin = new Elysia({ name: "tofu-dashboard-api" })
  .use(torrentServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get(
    "/state",
    {
      query: dashboardQuerySchema,
      sync: { id: "tofu.dashboard", scope: {} },
    },
    async ({ torrents, query }) => {
      const state = await torrents.refreshSnapshot(1000);
      const selected = query.selected ?? state.torrents[0]?.id;
      const detail =
        query.detail !== "false" &&
        selected &&
        state.torrents.some((torrent) => torrent.id === selected)
          ? await torrents.detail(selected)
          : null;
      return { ...state, detail };
    }
  );
