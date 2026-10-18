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
    async ({ torrents, torrentFolders, body }) => {
      const settings = await torrents.updateSettings(body);
      // The default thread follows the download folder.
      torrentFolders.sync();
      return settings;
    }
  )
  .patch("/settings", { body: settingsPatchSchema }, async ({ torrents, torrentFolders, body }) => {
    const settings = await torrents.updateSettings(body);
    torrentFolders.sync();
    return settings;
  });
