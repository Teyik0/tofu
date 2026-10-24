import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { torrentServicePlugin } from "../torrents/plugin";
import { StorageRoots } from "./roots";

export const storageRootsServicePlugin = new Elysia({
  name: "tofu-storage-roots-service",
})
  .use(databasePlugin)
  .use(torrentServicePlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    storageRoots: new StorageRoots({
      db: dependencies.db,
      defaultPath: () => dependencies.torrents.settings.downloadPath,
      now: Date.now,
    }),
  }));
