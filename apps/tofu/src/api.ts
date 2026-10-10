import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { createAniListOpeningApi } from "@tofu/anilist/opening-api";
import { createAutomationReadApi } from "@tofu/plugins/automation-read-api";
import { Elysia } from "elysia";
import { type CoreServices, createCore, unavailableAutomation } from "./api/core";
import { createCoreApi } from "./api/core-api";
import type { TorrentEngine } from "./api/engine";
import { createExtensionsApi } from "./api/extensions-api";
import { createAutomationApi } from "./api/feeds/automation-api";
import { createDiscoveryApi } from "./api/feeds/discovery-api";
import type { AutomationService } from "./api/feeds/service";
import { createPluginHost, type PluginHostOptions } from "./api/plugin-host";
import { createJevApi } from "./api/plugins/jev-api";
import { createPluginManagementApi } from "./api/plugins/management-api";
import { createRequestGuard } from "./api/request-guard";
import {
  getAutomation,
  getDesktop,
  getEngine,
  getNativeSdk,
  getUpdates,
  instance,
  syncOptions,
} from "./api/runtime";

export function createApi(
  engine: () => TorrentEngine,
  sync: FurinSyncOptions,
  automation?: () => AutomationService,
  services?: CoreServices,
  pluginOptions?: PluginHostOptions
) {
  const dependencies = { automation, engine, services, sync };
  const core = createCore(dependencies);
  const coreApi = createCoreApi(dependencies);
  const jev = createJevApi(dependencies);
  const plugins = createPluginHost(dependencies, pluginOptions);
  const mountPluginApi = (prefix: string) => (request: Request) => {
    const url = new URL(request.url);
    url.pathname = `${prefix}${url.pathname === "/" ? "" : url.pathname}`;
    return plugins.handle(new Request(url, request));
  };
  const app = new Elysia({ name: "tofu-api" })
    .use(createRequestGuard())
    .use(core)
    .use(furinSync(sync))
    .guard({ sync: false })
    .error(({ error, set }) => {
      set.status =
        error instanceof Error && "status" in error && typeof error.status === "number"
          ? error.status
          : 500;
      return { error: error instanceof Error ? error.message : "Unexpected error" };
    })
    .use(coreApi)
    .use(jev)
    .use(createExtensionsApi(plugins))
    .mount("/api/plugins", mountPluginApi("/api/plugins"))
    .mount("/api/anilist", mountPluginApi("/api/anilist"))
    .use(createAutomationReadApi(() => (automation ?? unavailableAutomation)().snapshot(), sync))
    .use(createAutomationApi(dependencies))
    .use(createDiscoveryApi(dependencies))
    .use(createPluginManagementApi(dependencies, plugins));
  return Object.assign(app, { closePlugins: plugins.close });
}

const configuredApi = createApi(getEngine, syncOptions, getAutomation, {
  desktop: getDesktop,
  instance: () => instance,
  nativeSdk: getNativeSdk,
  updates: getUpdates,
});

export const api = Object.assign(
  configuredApi.use(
    createAniListOpeningApi({
      isDesktop: () => getEngine().mode === "desktop",
      openExternal: (url) => Promise.resolve(getNativeSdk().Utils.openExternal(url)),
    })
  ),
  { closePlugins: configuredApi.closePlugins }
);
