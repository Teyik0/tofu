import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { db } from "../../lib/database-plugin";
import { access, accessPlugin } from "../access/plugin";
import { LinkedLibraries } from "./service";

export const linkedLibraries = new LinkedLibraries({
  db,
  now: Date.now,
  serverId: () => access.identity().serverId,
});

export const linkedLibrariesServicePlugin = new Elysia({ name: "tofu-linked-libraries-service" })
  .use(accessPlugin)
  .decorate("linkedLibraries", linkedLibraries);
