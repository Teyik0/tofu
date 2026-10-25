import { furinSync } from "@teyik0/furin/sync";
import { Context, Effect } from "effect";
import { Elysia } from "elysia";
import { services } from "@/api/lib/services-runtime";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { Updates } from "./service";

export const updatesPlugin = new Elysia({ name: "tofu-updates-api", prefix: "/updates" })
  .decorate("updates", Context.get(services, Updates))
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("", ({ updates }) => updates.snapshot())
  .post("/check", ({ updates }) => Effect.runPromise(updates.check()))
  // Installing replaces the host application; only its owner decides.
  .guard({ owner: true })
  .post("/prepare", ({ updates }) => Effect.runPromise(updates.prepare()))
  .post("/install", ({ updates }) => updates.install())
  .get("/download", ({ updates }) => Effect.runPromise(updates.download()));
