import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { pluginEndpoints } from "../plugins/service";
import { JevService } from "./service";

export const jevServicePlugin = new Elysia({ name: "tofu-jev-service" })
  .use(databasePlugin)
  .use(pluginRegistryPlugin)
  .decorate((dependencies) => {
    const jev = new JevService(dependencies.db, {
      endpoint: pluginEndpoints.jev,
      now: Date.now,
      plugins: dependencies.plugins,
    });
    dependencies.resources.defer(jev.close.bind(jev));
    return { ...dependencies, jev };
  });
