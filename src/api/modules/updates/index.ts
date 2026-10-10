import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";

export const updatesPlugin = new Elysia({ name: "tofu-updates-api", prefix: "/updates" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("", { sync: { id: "tofu.updates", scope: {} } }, ({ application }) =>
    application.updates.snapshot()
  )
  .post("/check", ({ application }) => application.updates.check())
  .post("/prepare", ({ application }) => application.updates.prepare())
  .post("/install", ({ application }) => application.updates.install())
  .get("/download", ({ application }) => application.updates.download());
