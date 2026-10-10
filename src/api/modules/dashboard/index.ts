import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { dashboardQuerySchema } from "./model";

export const dashboard = new Elysia({ name: "tofu-dashboard-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .get(
    "/state",
    {
      query: dashboardQuerySchema,
      sync: { id: "tofu.dashboard", scope: {} },
    },
    async ({ query }) => {
      const state = services.engine.snapshot(null, false);
      const selected = query.selected ?? state.torrents[0]?.id;
      const detail =
        query.detail !== "false" &&
        selected &&
        state.torrents.some((torrent) => torrent.id === selected)
          ? await services.engine.detail(selected)
          : null;
      return { ...state, detail };
    }
  );
