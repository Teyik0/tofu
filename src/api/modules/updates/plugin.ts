import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { UpdatesService } from "./service";

export const updatesServicePlugin = new Elysia({ name: "tofu-updates-service" })
  .use(databasePlugin)
  .use(async (app) => {
    const updates = await UpdatesService.open({
      apiOrigin: "https://api.github.com",
      arch: process.arch,
      dataDir: instance.dataDir,
      notify: () => undefined,
      platform: process.platform,
      version,
    });

    return app.decorate("updates", updates).onStart(updates.start.bind(updates));
  });

await updatesServicePlugin.modules;
