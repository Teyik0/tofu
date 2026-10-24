import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { Jev } from "../../lib/services-layer";
import { services } from "../../lib/services-runtime";
import { pluginRegistryPlugin } from "../plugins/plugin";

export const jevServicePlugin = new Elysia({ name: "tofu-jev-service" })
  .use(databasePlugin)
  .use(pluginRegistryPlugin)
  .decorate("jev", Context.get(services, Jev));
