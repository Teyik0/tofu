import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin, services } from "../../lib/services-runtime";
import { Automation } from "./service";

export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(databasePlugin)
  .decorate("automation", Context.get(services, Automation));
