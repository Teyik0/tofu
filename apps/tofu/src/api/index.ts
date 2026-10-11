import { createCoreAutomationApi } from "@tofu/plugins/automation-read-api";
import "@teyik0/furin/server-only";
import { createAniListApi } from "@tofu/anilist/api";
import { Elysia } from "elysia";
import { sync } from "../sync";
import { createExtensionsApi } from "./extensions-api";
import { currentApplication, pluginHost } from "./lib/extensions";
import { automationPlugin } from "./modules/automation";
import { dashboardPlugin } from "./modules/dashboard";
import { desktopPlugin } from "./modules/desktop";
import { destinationsPlugin } from "./modules/destinations";
import { discoveryPlugin } from "./modules/discovery";
import { healthPlugin } from "./modules/health";
import { jevPlugin } from "./modules/jev";
import { pluginsPlugin } from "./modules/plugins";
import { settingsPlugin } from "./modules/settings";
import { torrentPlugin } from "./modules/torrents";
import { updatesPlugin } from "./modules/updates";

function forward(prefix: string, request: Request) {
  const url = new URL(request.url);
  url.pathname = prefix + (url.pathname === "/" ? "" : url.pathname);
  return pluginHost().handle(new Request(url, request));
}

export const apiPlugin = new Elysia({ name: "tofu-api" })
  .group("/api", (api) =>
    api
      .use(healthPlugin)
      .use(settingsPlugin)
      .use(dashboardPlugin)
      .use(torrentPlugin)
      .use(destinationsPlugin)
      .use(automationPlugin)
      .use(discoveryPlugin)
      .use(pluginsPlugin)
      .use(jevPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
  )
  .use(
    createCoreAutomationApi(
      () => currentApplication().automation.snapshot(),
      () => currentApplication().automation,
      sync
    )
  )
  .use(createExtensionsApi(pluginHost))
  // Mounted routers remain dynamic and make Furin skip its single-router AOT build.
  .guard({ sync: false }, (dynamic) =>
    dynamic
      .mount("/api/plugins", (request) => forward("/api/plugins", request))
      .mount("/api/anilist", (request) => forward("/api/anilist", request))
  );

// Compose the same official API for Eden inference without registering its routes twice.
function typedApi() {
  return new Elysia()
    .use(apiPlugin)
    .use(createAniListApi({ application: currentApplication, sync }));
}
export type Api = ReturnType<typeof typedApi>;
