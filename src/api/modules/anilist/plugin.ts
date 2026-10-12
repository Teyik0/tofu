import { Elysia } from "elysia";
import { db, instance } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { automation, automationPlugin } from "../automation";
import { releaseAutomation, releaseAutomationPlugin } from "../automation/plugin";
import { discovery } from "../discovery/plugin";
import { jev } from "../jev/plugin";
import { plugins } from "../plugins/plugin";
import { engine } from "../torrents/plugin";
import { readAniListClient } from "./client";
import { AniListService } from "./service";

const client = await readAniListClient(
  instance.profile,
  process.env.TOFU_ANILIST_CLIENT_ID,
  process.execPath
);
export const anilist = new AniListService(db, {
  automation,
  client,
  discovery,
  endpoint: "https://graphql.anilist.co",
  engine,
  jev,
  now: Date.now,
  plugins,
  releaseAutomation,
  tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
});

export const anilistServicePlugin = new Elysia({ name: "tofu-anilist-service" })
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .decorate("anilist", anilist);
resources.defer(anilist.close.bind(anilist));
anilistServicePlugin.setup(() => {
  void anilist.start().catch(console.error);
});
