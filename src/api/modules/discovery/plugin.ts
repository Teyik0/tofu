import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { jev, jevServicePlugin } from "../jev/plugin";
import { plugins } from "../plugins/plugin";
import { pluginEndpoints } from "../plugins/service";
import { engine, torrentServicePlugin } from "../torrents/plugin";
import { DiscoveryService } from "./service";

export const discovery = new DiscoveryService(db, {
  endpoints: pluginEndpoints,
  engine,
  jev,
  plugins,
});
export const discoveryServicePlugin = new Elysia({ name: "tofu-discovery-service" })
  .use(jevServicePlugin)
  .use(torrentServicePlugin)
  .decorate("discovery", discovery);
resources.defer(discovery.close.bind(discovery));
