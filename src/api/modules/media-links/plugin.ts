import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { MediaLinks } from "./service";

export const mediaLinksServicePlugin = new Elysia({ name: "tofu-media-links-service" })
  .use(databasePlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    mediaLinks: new MediaLinks({
      db: dependencies.db,
      now: Date.now,
    }),
  }));
