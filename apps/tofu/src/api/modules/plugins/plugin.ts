import { Elysia } from "elysia";
import { databasePlugin, db } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { PluginsService, pluginEndpoints } from "./service";

export const plugins = new PluginsService(db, { endpoints: pluginEndpoints, now: Date.now });
export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate("plugins", plugins);
resources.defer(plugins.close.bind(plugins));
