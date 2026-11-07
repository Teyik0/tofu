import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin, services } from "../../lib/services-runtime";
import { Transmission } from "./service";

export const transmissionServicePlugin = new Elysia({ name: "tofu-transmission-service" })
  .use(databasePlugin)
  .decorate("transmission", Context.get(services, Transmission));
