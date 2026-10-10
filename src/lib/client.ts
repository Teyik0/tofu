import { createIsomorphicFn } from "@teyik0/furin";
import { createClient } from "@teyik0/furin/client";
import { type Api, apiPlugin } from "@/api";

export const api = createIsomorphicFn()
  .server(() => createClient(apiPlugin).api)
  .client(
    () =>
      createClient<Api>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).api
  )();
