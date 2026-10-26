import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { settingsPatchSchema, settingsSchema } from "./model";
import { changesOwnerSettings } from "./service";

export const settingsPlugin = new Elysia({ name: "tofu-settings-api" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("/settings", ({ torrents }) => torrents.settings())
  .put(
    "/settings",
    { body: settingsSchema },
    async ({ caller, torrents, torrentFolders, torrentFoldersRuntime, body }) => {
      if (caller.kind !== "owner" && changesOwnerSettings(torrents.settings(), body)) {
        return problem(403, { detail: "Change this on the server itself" });
      }
      const settings = await torrents.call("updateSettings", [body]);
      if (settings instanceof ElysiaStatus) {
        return settings;
      }
      // The default thread follows the download folder.
      torrentFoldersRuntime.runSync(torrentFolders.sync);
      return settings;
    }
  )
  .patch(
    "/settings",
    { body: settingsPatchSchema },
    async ({ caller, torrents, torrentFolders, torrentFoldersRuntime, body }) => {
      if (caller.kind !== "owner" && changesOwnerSettings(torrents.settings(), body)) {
        return problem(403, { detail: "Change this on the server itself" });
      }
      const settings = await torrents.call("updateSettings", [body]);
      if (settings instanceof ElysiaStatus) {
        return settings;
      }
      torrentFoldersRuntime.runSync(torrentFolders.sync);
      return settings;
    }
  );
