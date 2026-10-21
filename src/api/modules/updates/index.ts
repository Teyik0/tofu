import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { updatesServicePlugin } from "./plugin";

export const updatesPlugin = new Elysia({ name: "tofu-updates-api", prefix: "/updates" })
  .use(updatesServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("", ({ updates }) => updates.snapshot())
  .post("/check", ({ updates }) => updates.check())
  // Installing replaces the host application; only its owner decides.
  .guard({ owner: true })
  .post("/prepare", ({ updates }) => updates.prepare())
  .post("/install", ({ updates }) => updates.install())
  .get("/download", ({ updates }) => updates.download());
