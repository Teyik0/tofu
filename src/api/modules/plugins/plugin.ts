import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { PluginsService, pluginEndpoints } from "./service";

export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate((dependencies) => {
    const plugins = new PluginsService(dependencies.db, {
      endpoints: pluginEndpoints,
      now: Date.now,
    });
    dependencies.resources.defer(plugins.close.bind(plugins));
    return { ...dependencies, plugins };
  });
