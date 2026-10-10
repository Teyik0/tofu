import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { type CoreServices, createCore } from "./api/core";
import { createCoreApi } from "./api/core-api";
import type { TorrentEngine } from "./api/engine";
import { createAniListApi } from "./api/feeds/anilist-api";
import { createAniListOpeningApi } from "./api/feeds/anilist-opening-api";
import { createAutomationApi } from "./api/feeds/automation-api";
import { createDiscoveryApi } from "./api/feeds/discovery-api";
import type { AutomationService } from "./api/feeds/service";
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
  services?: CoreServices
) {
  const dependencies = { automation, engine, services, sync };
  const core = createCore(dependencies);
  const coreApi = createCoreApi(dependencies);
  const jev = createJevApi(dependencies);
  const anilist = createAniListApi(dependencies);
  return new Elysia({ name: "tofu-api" })
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
    .use(anilist)
    .use(createAutomationApi(dependencies))
    .use(createDiscoveryApi(dependencies))
    .use(createPluginManagementApi(dependencies));
}

export const api = createApi(getEngine, syncOptions, getAutomation, {
  desktop: getDesktop,
  instance: () => instance,
  nativeSdk: getNativeSdk,
  updates: getUpdates,
}).use(
  createAniListOpeningApi({
    isDesktop: () => getEngine().mode === "desktop",
    openExternal: (url) => Promise.resolve(getNativeSdk().Utils.openExternal(url)),
  })
);
