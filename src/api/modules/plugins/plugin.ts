import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { Plugins } from "../../lib/services-layer";
import { services } from "../../lib/services-runtime";

export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate("plugins", Context.get(services, Plugins));
