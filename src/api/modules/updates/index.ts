import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { updatesServicePlugin } from "./plugin";

export const updatesPlugin = new Elysia({ name: "tofu-updates-api", prefix: "/updates" })
  .use(updatesServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("", { sync: { id: "tofu.updates", scope: {} } }, ({ updates }) => updates.snapshot())
  .post("/check", ({ updates }) => updates.check())
  .post("/prepare", ({ updates }) => updates.prepare())
  .post("/install", ({ updates }) => updates.install())
  .get("/download", ({ updates }) => updates.download());
