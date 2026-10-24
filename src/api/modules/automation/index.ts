import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { Automation } from "../../lib/services-layer";
import { services } from "../../lib/services-runtime";
import { jevServicePlugin } from "../jev/plugin";

export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(databasePlugin)
  .use(jevServicePlugin)
  .decorate("automation", Context.get(services, Automation));
