import { Elysia, t } from "elysia";
import type { UpdatesService } from "./updates";

export function createUpdatesApi(updates: () => UpdatesService, sync: FurinSyncOptions) {
  return new Elysia({ prefix: "/updates" })
    .use(furinSync(sync))
    .guard({ sync: false })
    .get("", { sync: { id: "tofu.updates", scope: {} } }, () => updates().snapshot())
    .post("/check", () => updates().check())
    .post(
      "/access",
      {
        body: t.Object({
          clearToken: t.Optional(t.Boolean()),
          token: t.Optional(t.String({ maxLength: 4096, minLength: 1 })),
        }),
      },
      ({ body }) => updates().configure(body)
    )
    .get("/download", () => updates().download());
}

import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
