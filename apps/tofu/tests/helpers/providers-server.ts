import { furinSync } from "@teyik0/furin/sync";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { instance } from "../../src/api/lib/instance";
import { servicesRuntime } from "../../src/api/lib/services-runtime";
import { publicDocumentsPlugin } from "../../src/api/modules/access/documents";
import { accessRoutesPlugin } from "../../src/api/modules/access/index";
import { accessPlugin } from "../../src/api/modules/access/plugin";
import { anilistPlugin } from "../../src/api/modules/anilist/index";
import { anilistOpeningPlugin } from "../../src/api/modules/anilist/opening";
import { automationManagementPlugin } from "../../src/api/modules/automation/management";
import { dashboardPlugin } from "../../src/api/modules/dashboard/index";
import { desktopPlugin } from "../../src/api/modules/desktop/index";
import { destinationsPlugin } from "../../src/api/modules/destinations/index";
import { discoveryPlugin } from "../../src/api/modules/discovery/index";
import {
  libraryAvailabilityPlugin,
  linkedLibrariesPlugin,
} from "../../src/api/modules/library-links/index";
import { mediaLinksApiPlugin, mediaLinksPlugin } from "../../src/api/modules/media-links/index";
import { pluginsPlugin } from "../../src/api/modules/plugins/index";
import { torrentPlugin } from "../../src/api/modules/torrents/index";
import { sync } from "../../src/sync";

const app = new Elysia({ name: "tofu-providers-integration" })
  .use(accessPlugin)
  .use(desktopApp(({ access }) => ({ admission: access.admit.bind(access) })))
  .use(publicDocumentsPlugin)
  .use(mediaLinksPlugin)
  .use(furinSync(sync))
  .group("/api", (api) =>
    api
      .use(accessRoutesPlugin)
      .use(anilistPlugin)
      .use(anilistOpeningPlugin)
      .use(automationManagementPlugin)
      .use(dashboardPlugin)
      .use(destinationsPlugin)
      .use(desktopPlugin)
      .use(discoveryPlugin)
      .use(libraryAvailabilityPlugin)
      .use(linkedLibrariesPlugin)
      .use(mediaLinksApiPlugin)
      .use(pluginsPlugin)
      .use(torrentPlugin)
  )
  .onStop(() => servicesRuntime.dispose())
  .listen({ hostname: "127.0.0.1", idleTimeout: 30, port: instance.port });

process.once("SIGTERM", async () => {
  await app.stop(true);
  process.exit(0);
});
