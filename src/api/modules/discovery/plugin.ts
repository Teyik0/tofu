import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { jevServicePlugin } from "../jev/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { pluginEndpoints } from "../plugins/service";
import { torrentServicePlugin } from "../torrents/plugin";
import { DiscoveryService } from "./service";

export const discoveryServicePlugin = new Elysia({ name: "tofu-discovery-service" })
  .use(databasePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .decorate((dependencies) => {
    const discovery = new DiscoveryService(dependencies.db, {
      endpoints: pluginEndpoints,
      engine: dependencies.torrents,
      jev: dependencies.jev,
      plugins: dependencies.plugins,
    });
    dependencies.resources.defer(discovery.close.bind(discovery));
    return { ...dependencies, discovery };
  });
