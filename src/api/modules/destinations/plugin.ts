import "@teyik0/furin/server-only";
import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { Roots } from "../../lib/services-layer";
import { services } from "../../lib/services-runtime";
import { torrentServicePlugin } from "../torrents/plugin";

export const storageRootsServicePlugin = new Elysia({ name: "tofu-storage-roots-service" })
  .use(databasePlugin)
  .use(torrentServicePlugin)
  .decorate("storageRoots", Context.get(services, Roots));
