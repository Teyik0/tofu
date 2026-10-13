import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { jev, jevServicePlugin } from "../jev/plugin";
import { AutomationService } from "./service";

export const automation = new AutomationService(db, { jev, now: Date.now });
export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(jevServicePlugin)
  .decorate("automation", automation);
export type AutomationPlugin = typeof automationPlugin;
