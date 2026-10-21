import { Elysia } from "elysia";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { automationPlugin } from "../automation";
import { releaseAutomationPlugin } from "../automation/plugin";
import { discoveryServicePlugin } from "../discovery/plugin";
import { jevServicePlugin } from "../jev/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { readAniListClient } from "./client";
import { AniListService } from "./service";

const client = await readAniListClient(
  instance.profile,
  process.env.TOFU_ANILIST_CLIENT_ID,
  process.execPath
);

export const anilistServicePlugin = new Elysia({ name: "tofu-anilist-service" })
  .use(databasePlugin)
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(discoveryServicePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .use((app) =>
    app.decorate((dependencies) => {
      const anilist = new AniListService(dependencies.db, {
        automation: dependencies.automation,
        client,
        discovery: dependencies.discovery,
        endpoint: "https://graphql.anilist.co",
        engine: dependencies.torrents,
        jev: dependencies.jev,
        now: Date.now,
        plugins: dependencies.plugins,
        releaseAutomation: dependencies.releaseAutomation,
        tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
      });

      app.onStart(anilist.start.bind(anilist));

      return { ...dependencies, anilist };
    })
  );
