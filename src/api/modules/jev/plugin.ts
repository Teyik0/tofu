import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { pluginRegistryPlugin, plugins } from "../plugins/plugin";
import { pluginEndpoints } from "../plugins/service";
import { JevService } from "./service";

export const jev = new JevService(db, { endpoint: pluginEndpoints.jev, now: Date.now, plugins });
export const jevServicePlugin = new Elysia({ name: "tofu-jev-service" })
  .use(pluginRegistryPlugin)
  .decorate("jev", jev);
resources.defer(jev.close.bind(jev));
