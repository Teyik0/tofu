import "@teyik0/furin/server-only";
import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { services } from "../../lib/services-runtime";
import { PlaybackLinks } from "./service";

export const mediaLinksServicePlugin = new Elysia({ name: "tofu-media-links-service" })
  .use(databasePlugin)
  .decorate("mediaLinks", Context.get(services, PlaybackLinks));
