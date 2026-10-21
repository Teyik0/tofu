import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { databasePlugin } from "../../lib/database-plugin";
import { accessPlugin } from "../access/plugin";
import { LinkedLibraries } from "./service";

export const linkedLibrariesServicePlugin = new Elysia({ name: "tofu-linked-libraries-service" })
  .use(databasePlugin)
  .use(accessPlugin)
  .decorate((dependencies) => ({
    ...dependencies,
    linkedLibraries: new LinkedLibraries({
      db: dependencies.db,
      now: Date.now,
      serverId: () => dependencies.access.identity().serverId,
    }),
  }));
