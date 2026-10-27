import { treaty } from "@elysia/eden";
import { furinSync } from "@teyik0/furin/client";
import { bindAniListClients } from "@tofu/anilist/server-clients";
import { extensionsPlugin, externalPluginRoutes } from "./extensions-api";
import { pluginHost } from "./lib/extensions";
import "@teyik0/furin/server-only";

import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Context, Effect } from "effect";
import { Elysia } from "elysia";
import { toMiddlewareOptions } from "evlog";
import { evlog, useLogger } from "evlog/elysia";
import { config } from "../../evlog.config";
import { httpPolicyPlugin } from "./lib/http-policy";
import { instance } from "./lib/instance";
import { services, servicesRuntime } from "./lib/services-runtime";
import { publicDocumentsPlugin } from "./modules/access/documents";
import { accessRoutesPlugin } from "./modules/access/index";
import { Access } from "./modules/access/layer";
import { accessPlugin } from "./modules/access/plugin";
import { anilistPlugin } from "./modules/anilist/index";
import { anilistOpeningPlugin } from "./modules/anilist/opening";
import { anilistServicePlugin } from "./modules/anilist/plugin";
import { automationManagementPlugin } from "./modules/automation/management";
import { releaseAutomationPlugin } from "./modules/automation/plugin";
import { dashboardPlugin } from "./modules/dashboard/index";
import { desktopPlugin } from "./modules/desktop/index";
import { desktopNativeOpenPlugin } from "./modules/desktop/native-open";
import { destinationsPlugin } from "./modules/destinations/index";
import { storageRootsPlugin } from "./modules/destinations/storage";
import { discoveryPlugin } from "./modules/discovery/index";
import { discoveryServicePlugin } from "./modules/discovery/plugin";
import { healthPlugin } from "./modules/health/index";
import { libraryAvailabilityPlugin, linkedLibrariesPlugin } from "./modules/library-links/index";
import { mediaLinksApiPlugin, mediaLinksPlugin } from "./modules/media-links/index";
import { playbackPlugin } from "./modules/playback/index";
import { playerPlugin } from "./modules/player/index";
import { pluginsPlugin } from "./modules/plugins/index";
import { pluginRegistryPlugin } from "./modules/plugins/plugin";
import { settingsPlugin } from "./modules/settings/index";
import { torrentPlugin } from "./modules/torrents/index";
import { torrentServicePlugin, torrents } from "./modules/torrents/plugin";
import { updatesPlugin } from "./modules/updates/index";

await Effect.runPromise(
  Effect.tryPromise(() => pluginHost.initialize()).pipe(
    Effect.onError(() =>
      Effect.promise(async () => {
        await using resources = new AsyncDisposableStack();
        resources.defer(() => servicesRuntime.dispose());
        resources.defer(() => pluginHost.close());
      })
    )
  )
);

const { access } = Context.get(services, Access);

export const apiPlugin = new Elysia({ name: "tofu-api" })
  .use(
    desktopApp({
      admission: access.admit.bind(access),
      background: () => torrents.settings().runInBackground === true,
      window: { frame: { height: 940, width: 1400 }, renderer: "native", title: instance.name },
    })
  )
  .use(evlog(toMiddlewareOptions(config)))
  .use(anilistServicePlugin)
  .use(releaseAutomationPlugin)
  .use(discoveryServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .use(desktopNativeOpenPlugin)
  .use(accessPlugin)
  .use(publicDocumentsPlugin)
  .use(mediaLinksPlugin)
  .use(httpPolicyPlugin)
  .onStop(async () => {
    await using resources = new AsyncDisposableStack();
    resources.defer(() => servicesRuntime.dispose());
    resources.defer(() => pluginHost.close());
  })
  .group("/api", (app) =>
    app
      .derive(() => ({ log: useLogger() }))
      .onBeforeHandle(({ log }) => {
        log.set({
          component: "api",
          dataDir: instance.dataDir,
          operation: "request",
        });
      })
      .use(extensionsPlugin)
      .use(externalPluginRoutes)
      .use(accessRoutesPlugin)
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
      .use(playerPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
  );

export type Api = typeof apiPlugin;

bindAniListClients({
  api: treaty(apiPlugin).use(furinSync).api,
  coreClient: treaty(apiPlugin).use(furinSync).api,
});
