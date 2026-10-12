import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { torrentServicePlugin } from "../torrents/plugin";
import { settingsPatchSchema, settingsSchema } from "./model";

export const settingsPlugin = new Elysia({ name: "tofu-settings-api" })
  .use(torrentServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/settings", ({ torrents }) => torrents.settings)
  .put(
    "/settings",
    {
      body: settingsSchema,
    },
    ({ torrents, body }) => torrents.updateSettings(body)
  )
  .patch("/settings", { body: settingsPatchSchema }, ({ torrents, body }) =>
    torrents.updateSettings(body)
  );
