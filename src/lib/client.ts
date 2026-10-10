import { createIsomorphicFn } from "@teyik0/furin";
import { createClient } from "@teyik0/furin/client";
import type { Api } from "@/api";
import { serverApiFetch } from "../api/lib/transport";

export const api = createIsomorphicFn()
  .server(() => createClient<Api>("http://tofu.internal", { fetcher: serverApiFetch }).api)
  .client(
    () =>
      createClient<Api>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).api
  )();
