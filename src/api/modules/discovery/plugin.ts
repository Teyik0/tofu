import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { services } from "../../lib/services-runtime";
import { jevServicePlugin } from "../jev/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { Discovery } from "./service";

export const discoveryServicePlugin = new Elysia({ name: "tofu-discovery-service" })
  .use(databasePlugin)
  .use(jevServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .decorate("discovery", Context.get(services, Discovery));
