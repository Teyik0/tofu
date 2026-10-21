import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { PluginsService, pluginEndpoints } from "./service";

export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    plugins: new PluginsService(dependencies.db, {
      endpoints: pluginEndpoints,
      now: Date.now,
    }),
  }));
