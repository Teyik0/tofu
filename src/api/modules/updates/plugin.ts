import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { UpdatesService } from "./service";

export const updates = await UpdatesService.open({
  apiOrigin: "https://api.github.com",
  arch: process.arch,
  dataDir: instance.dataDir,
  notify: () => undefined,
  platform: process.platform,
  version,
});
export const updatesServicePlugin = new Elysia({ name: "tofu-updates-service" })
  .use(databasePlugin)
  .decorate("updates", updates);
resources.defer(updates.close.bind(updates));
updatesServicePlugin.setup(() => {
  updates.start();
});
