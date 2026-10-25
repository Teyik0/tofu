import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/db";
import { services } from "../../lib/services-runtime";
import { jevServicePlugin } from "../jev/plugin";
import { Automation } from "./service";

export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(databasePlugin)
  .use(jevServicePlugin)
  .decorate("automation", Context.get(services, Automation));
