import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin } from "../../lib/db";
import { instance } from "../../lib/instance";
import { reserveInitialization } from "../../lib/lifecycle-plugin";
import { UpdatesService } from "./service";

using _initialization = reserveInitialization();

export const updatesServicePlugin = new Elysia({ name: "tofu-updates-service" })
  .use(databasePlugin)
  .use(async (app) => {
    await using startup = new AsyncDisposableStack();
    const updates = await UpdatesService.open({
      apiOrigin: "https://api.github.com",
      arch: process.arch,
      dataDir: instance.dataDir,
      notify: () => undefined,
      platform: process.platform,
      version,
    });

    startup.defer(updates.close.bind(updates));
    return app.decorate((dependencies) => {
      dependencies.resources.use(startup.move());
      return { ...dependencies, updates };
    });
  });

await updatesServicePlugin.modules;
