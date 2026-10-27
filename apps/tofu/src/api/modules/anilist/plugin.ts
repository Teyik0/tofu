import { Context } from "effect";
import { Elysia } from "elysia";
import { AniList } from "../../../../../../package/anilist/src/server/service";
import { databasePlugin, services } from "../../lib/services-runtime";
import { automationPlugin } from "../automation/index";
import { releaseAutomationPlugin } from "../automation/plugin";
import { discoveryServicePlugin } from "../discovery/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";

export const anilistServicePlugin = new Elysia({ name: "tofu-anilist-service" })
  .use(databasePlugin)
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(discoveryServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .decorate("anilist", Context.get(services, AniList));
