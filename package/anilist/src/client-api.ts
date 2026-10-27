import { type ExtractPluginTypeFn, type Treaty, treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/client";
import type { createCoreAutomationApi } from "@tofu/plugins/automation-read-api";
import type { AniListApi } from "./server/api";
import type { createAniListOpeningApi } from "./server/opening";

type CoreApi = ReturnType<typeof createCoreAutomationApi>;
type OpeningApi = ReturnType<typeof createAniListOpeningApi<"/api">>;
type CombinedApi = import("elysia").Elysia<
  "",
  "local",
  import("elysia").Elysia["~Singleton"],
  import("elysia").Elysia["~Definitions"],
  import("elysia").Elysia["~Metadata"],
  AniListApi["~Routes"] & CoreApi["~Routes"] & OpeningApi["~Routes"]
>;
type SyncClient<App extends import("elysia").AnyElysia> = Treaty.Instance<
  App,
  Record<never, never>,
  [ExtractPluginTypeFn<typeof furinSync>]
>["api"];
export interface AniListServerClients {
  api: SyncClient<CombinedApi>;
  coreClient: SyncClient<ReturnType<typeof createCoreAutomationApi>>;
}
export let api: AniListServerClients["api"];
export let coreClient: AniListServerClients["coreClient"];
createIsomorphicFn()
  .server(() => undefined)
  .client(() => {
    ({ api } = treaty<CombinedApi>(window.location.origin, {
      fetch: { cache: "no-store", credentials: "include" },
    }).use(furinSync));
    ({ api: coreClient } = treaty<ReturnType<typeof createCoreAutomationApi>>(
      window.location.origin,
      {
        fetch: { cache: "no-store", credentials: "include" },
      }
    ).use(furinSync));
  })();
export function bindAniListClients(clients: AniListServerClients) {
  ({ api, coreClient } = clients);
}
