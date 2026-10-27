import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/client";
import { type Api, apiPlugin } from "@/api";

export const api = createIsomorphicFn()
  .server(() => treaty(apiPlugin).use(furinSync).api)
  .client(
    () =>
      treaty<Api>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).use(furinSync).api
  )();
