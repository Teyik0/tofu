import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { dashboardQuerySchema } from "./model";

export const dashboardPlugin = new Elysia({ name: "tofu-dashboard-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get(
    "/state",
    {
      query: dashboardQuerySchema,
      sync: { id: "tofu.dashboard", scope: {} },
    },
    async ({ application, query }) => {
      const state = application.engine.snapshot(null, false);
      const selected = query.selected ?? state.torrents[0]?.id;
      const detail =
        query.detail !== "false" &&
        selected &&
        state.torrents.some((torrent) => torrent.id === selected)
          ? await application.engine.detail(selected)
          : null;
      return { ...state, detail };
    }
  );
