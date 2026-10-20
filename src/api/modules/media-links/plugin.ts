import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { MediaLinks } from "./service";

export const mediaLinks = new MediaLinks({ db, now: Date.now });

export const mediaLinksServicePlugin = new Elysia({ name: "tofu-media-links-service" }).decorate(
  "mediaLinks",
  mediaLinks
);
