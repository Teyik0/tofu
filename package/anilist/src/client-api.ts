import { createIsomorphicFn } from "@teyik0/furin";
import type { createCoreAutomationApi } from "@tofu/plugins/automation-read-api";
import { createClient } from "@tofu/plugins/client";
import { serverApiFetch } from "@tofu/plugins/transport";
import type { createAniListApi } from "./server/api";

export const api = createIsomorphicFn()
  .server(
    () =>
      createClient<ReturnType<typeof createAniListApi>>("http://tofu.internal", {
        fetcher: serverApiFetch,
      }).api
  )
  .client(
    () =>
      createClient<ReturnType<typeof createAniListApi>>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).api
  )();

export const coreClient = createIsomorphicFn()
  .server(
    () =>
      createClient<ReturnType<typeof createCoreAutomationApi>>("http://tofu.internal", {
        fetcher: serverApiFetch,
      }).api
  )
  .client(
    () =>
      createClient<ReturnType<typeof createCoreAutomationApi>>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).api
  )();
