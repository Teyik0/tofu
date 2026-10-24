import "@teyik0/furin/server-only";

import { Elysia } from "elysia";
import { toMiddlewareOptions } from "evlog";
import { evlog, useLogger } from "evlog/elysia";
import { config } from "../../evlog.config";
import { instance } from "./lib/database-plugin";
import { httpPolicyPlugin } from "./lib/http-policy";
import { accessRoutesPlugin } from "./modules/access";
import { publicDocumentsPlugin } from "./modules/access/documents";
import { accessPlugin } from "./modules/access/plugin";
import { anilistPlugin } from "./modules/anilist";
import { anilistOpeningPlugin } from "./modules/anilist/opening";
import { anilistServicePlugin } from "./modules/anilist/plugin";
import { automationManagementPlugin } from "./modules/automation/management";
import { releaseAutomationPlugin } from "./modules/automation/plugin";
import { connectionsPlugin } from "./modules/connections";
import { connectionsServicePlugin } from "./modules/connections/plugin";
import { dashboardPlugin } from "./modules/dashboard";
import { desktopPlugin } from "./modules/desktop";
import { desktopNativeOpenPlugin } from "./modules/desktop/native-open";
import { destinationsPlugin } from "./modules/destinations";
import { storageRootsPlugin } from "./modules/destinations/storage";
import { discoveryPlugin } from "./modules/discovery";
import { discoveryServicePlugin } from "./modules/discovery/plugin";
import { healthPlugin } from "./modules/health";
import { jevManagementPlugin } from "./modules/jev";
import { jevServicePlugin } from "./modules/jev/plugin";
import { libraryAvailabilityPlugin, linkedLibrariesPlugin } from "./modules/library-links";
import { mediaLinksApiPlugin, mediaLinksPlugin } from "./modules/media-links";
import { playbackPlugin } from "./modules/playback";
import { playerPlugin } from "./modules/player";
import { pluginsPlugin } from "./modules/plugins";
import { pluginRegistryPlugin } from "./modules/plugins/plugin";
import { settingsPlugin } from "./modules/settings";
import { torrentPlugin } from "./modules/torrents";
import { torrentServicePlugin } from "./modules/torrents/plugin";
import { updatesPlugin } from "./modules/updates";
import { updatesServicePlugin } from "./modules/updates/plugin";

export const apiPlugin = new Elysia({ name: "tofu-api" })
  .use(evlog(toMiddlewareOptions(config)))
  .derive(() => ({ log: useLogger() }))
  .use(anilistServicePlugin)
  .use(releaseAutomationPlugin)
  .use(connectionsServicePlugin)
  .use(discoveryServicePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .use(updatesServicePlugin)
  .use(desktopNativeOpenPlugin)
  .use(accessPlugin)
  .use(publicDocumentsPlugin)
  .use(mediaLinksPlugin)
  .use(httpPolicyPlugin)
  .onBeforeHandle(({ log }) => {
    log.set({
      component: "api",
      dataDir: instance.dataDir,
      operation: "request",
    });
  })
  .group("/api", (app) =>
    app
      .use(accessRoutesPlugin)
      .use(connectionsPlugin)
      .use(mediaLinksApiPlugin)
      .use(libraryAvailabilityPlugin)
      .use(linkedLibrariesPlugin)
      .use(playbackPlugin)
      .use(healthPlugin)
      .use(settingsPlugin)
      .use(dashboardPlugin)
      .use(torrentPlugin)
      .use(destinationsPlugin)
      .use(storageRootsPlugin)
      .use(anilistPlugin)
      .use(anilistOpeningPlugin)
      .use(automationManagementPlugin)
      .use(discoveryPlugin)
      .use(pluginsPlugin)
      .use(jevManagementPlugin)
      .use(playerPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
  );

export type Api = typeof apiPlugin;
