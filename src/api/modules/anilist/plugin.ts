import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { AniList } from "../../lib/services-layer";
import { services } from "../../lib/services-runtime";
import { automationPlugin } from "../automation";
import { releaseAutomationPlugin } from "../automation/plugin";
import { discoveryServicePlugin } from "../discovery/plugin";
import { jevServicePlugin } from "../jev/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";

export const anilistServicePlugin = new Elysia({ name: "tofu-anilist-service" })
  .use(databasePlugin)
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(discoveryServicePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .decorate("anilist", Context.get(services, AniList));
