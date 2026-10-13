import { Elysia } from "elysia";
import { serviceApplications } from "./service-registry";

declare const TOFU_TEST_APPLICATION_ID: string;

const supplied = serviceApplications.get(TOFU_TEST_APPLICATION_ID);
if (!supplied) {
  throw new Error("The integration services were not supplied");
}
const { application, platform } = supplied;

export const {
  anilist,
  automation,
  db,
  discovery,
  engine,
  instance,
  logs,
  jev,
  plugins,
  releaseAutomation,
  resources,
  updates,
} = application;
export const runtime = { current: platform };

export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(databasePlugin)
  .decorate("torrents", engine);

export const pluginRegistryPlugin = new Elysia({ name: "tofu-plugin-registry-service" })
  .use(databasePlugin)
  .decorate("plugins", plugins);

export const jevServicePlugin = new Elysia({ name: "tofu-jev-service" })
  .use(pluginRegistryPlugin)
  .decorate("jev", jev);

export const automationPlugin = new Elysia({ name: "tofu-automation-service" })
  .use(jevServicePlugin)
  .decorate("automation", automation);

export const discoveryServicePlugin = new Elysia({ name: "tofu-discovery-service" })
  .use(jevServicePlugin)
  .use(torrentServicePlugin)
  .decorate("discovery", discovery);

export const releaseAutomationPlugin = new Elysia({
  name: "tofu-release-automation-integration",
})
  .use(automationPlugin)
  .use(discoveryServicePlugin)
  .decorate("releaseAutomation", releaseAutomation);

export const anilistServicePlugin = new Elysia({ name: "tofu-anilist-service" })
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .decorate("anilist", anilist);

export const updatesServicePlugin = new Elysia({ name: "tofu-updates-service" })
  .use(databasePlugin)
  .decorate("updates", updates);
