import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { jevServicePlugin } from "../jev/plugin";
import { AutomationService } from "./service";

export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(databasePlugin)
  .use(jevServicePlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    automation: new AutomationService(dependencies.db, {
      jev: dependencies.jev,
      now: Date.now,
    }),
  }));
