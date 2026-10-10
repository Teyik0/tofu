import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";

export const updates = new Elysia({ name: "tofu-updates-api", prefix: "/updates" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("", { sync: { id: "tofu.updates", scope: {} } }, () => services.updates.snapshot())
  .post("/check", () => services.updates.check())
  .post("/prepare", () => services.updates.prepare())
  .post("/install", () => services.updates.install())
  .get("/download", () => services.updates.download());
