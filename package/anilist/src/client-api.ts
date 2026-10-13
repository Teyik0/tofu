import { createIsomorphicFn } from "@teyik0/furin";
import type { createCoreAutomationApi } from "@tofu/plugins/automation-read-api";
import { createClient } from "@tofu/plugins/client";
import type { AniListApi } from "./server/api";

export interface AniListServerClients {
  api: ReturnType<typeof createClient<AniListApi>>["api"];
  coreClient: ReturnType<typeof createClient<ReturnType<typeof createCoreAutomationApi>>>["api"];
}

// The host binds its shared Eden clients before listening; route discovery only declares loaders.
export let api: AniListServerClients["api"];
export let coreClient: AniListServerClients["coreClient"];

createIsomorphicFn()
  .server(() => undefined)
  .client(() => {
    ({ api } = createClient<AniListApi>(window.location.origin, {
      fetch: { cache: "no-store", credentials: "include" },
    }));
    ({ api: coreClient } = createClient<ReturnType<typeof createCoreAutomationApi>>(
      window.location.origin,
      {
        fetch: { cache: "no-store", credentials: "include" },
      }
    ));
  })();

export function bindAniListClients(clients: AniListServerClients) {
  ({ api, coreClient } = clients);
}
