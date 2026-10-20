import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { engine } from "../torrents/plugin";
import { StorageRoots } from "./roots";

export const storageRoots = new StorageRoots({
  db,
  defaultPath: () => engine.settings.downloadPath,
  now: Date.now,
});

export const storageRootsServicePlugin = new Elysia({
  name: "tofu-storage-roots-service",
}).decorate("storageRoots", storageRoots);
