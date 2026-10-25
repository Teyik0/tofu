import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { services } from "../../lib/services-runtime";
import { Plugins } from "./service";

export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate("plugins", Context.get(services, Plugins));
