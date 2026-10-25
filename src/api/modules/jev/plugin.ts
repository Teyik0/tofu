import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { services } from "../../lib/services-runtime";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { Jev } from "./service";

export const jevServicePlugin = new Elysia({ name: "tofu-jev-service" })
  .use(databasePlugin)
  .use(pluginRegistryPlugin)
  .decorate("jev", Context.get(services, Jev));
