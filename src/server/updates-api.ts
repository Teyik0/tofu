import { Elysia } from "elysia";
import type { UpdatesService } from "./updates";

export function createUpdatesApi(updates: () => UpdatesService, sync: FurinSyncOptions) {
  return new Elysia({ prefix: "/updates" })
    .use(furinSync(sync))
    .guard({ sync: false })
    .get("", { sync: { id: "tofu.updates", scope: {} } }, () => updates().snapshot())
    .post("/check", () => updates().check())
    .post("/prepare", () => updates().prepare())
    .post("/install", () => updates().install())
    .get("/download", () => updates().download());
}

import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
