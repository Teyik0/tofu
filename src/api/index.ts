import { createLogger } from "evlog";
import "@teyik0/furin/server-only";
import { Elysia, ValidationError } from "elysia";
import { db, instance, lease, logs } from "./lib/database-plugin";
import { sanitizeLog } from "./lib/diagnostics";
import { httpPolicyPlugin } from "./lib/http-policy";
import { accessRoutesPlugin } from "./modules/access";
import { publicDocumentsPlugin } from "./modules/access/documents";
import { anilistPlugin } from "./modules/anilist";
import { anilistOpeningPlugin } from "./modules/anilist/opening";
import { anilistServicePlugin } from "./modules/anilist/plugin";
import { automationManagementPlugin } from "./modules/automation/management";
import { releaseAutomationPlugin } from "./modules/automation/plugin";
import { connectionsPlugin } from "./modules/connections";
import { connectionsServicePlugin } from "./modules/connections/plugin";
import { dashboardPlugin } from "./modules/dashboard";
import { desktopPlugin } from "./modules/desktop";
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
  .onError("global", ({ request, error }) => {
    const log = createLogger({
      component: "api",
      context: { method: request.method, path: new URL(request.url).pathname },
      dataDir: instance.dataDir,
      error: sanitizeLog(
        error instanceof ValidationError ? new Error("Request validation failed") : error
      ),
      operation: "request",
    });
    log.setLevel("error");
    log.emit();
  })
  .use(anilistServicePlugin)
  .use(releaseAutomationPlugin)
  .use(connectionsServicePlugin)
  .use(discoveryServicePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .use(updatesServicePlugin)
  .use((app) =>
    app.decorate((dependencies) => {
      const {
        anilist,
        connections,
        discovery,
        jev,
        plugins,
        releaseAutomation,
        torrentFolders,
        torrents,
        updates,
      } = dependencies;

      app.onStop(async () => {
        const errors: unknown[] = [];

        // Stop producers before the services they depend on.
        const phases = [
          [
            updates.close.bind(updates),
            anilist.close.bind(anilist),
            torrentFolders.close.bind(torrentFolders),
          ],
          [releaseAutomation.close.bind(releaseAutomation)],
          [discovery.close.bind(discovery)],
          [jev.close.bind(jev)],
          [plugins.close.bind(plugins)],
          [connections.close.bind(connections)],
          [torrents.close.bind(torrents)],
          [db.$client.close.bind(db.$client, true)],
          [logs.flush.bind(logs)],
          [lease.close.bind(lease)],
        ];

        for (const phase of phases) {
          // biome-ignore lint/performance/noAwaitInLoops: Shutdown phases must preserve dependency order.
          await Promise.all(
            phase.map(async (close) => {
              try {
                await close();
              } catch (error) {
                errors.push(error);
              }
            })
          );
        }

        if (errors.length > 0) {
          throw new AggregateError(errors, "Tofu could not stop every API service");
        }
      });

      return dependencies;
    })
  )
  .use(publicDocumentsPlugin)
  .use(mediaLinksPlugin)
  .use(httpPolicyPlugin)
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
