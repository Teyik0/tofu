import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { partial } from "valibot";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { settingsSchema } from "./model";

export const settingsPlugin = new Elysia({ name: "tofu-settings-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/settings", ({ application }) => application.engine.settings)
  .put(
    "/settings",
    {
      body: settingsSchema,
    },
    ({ application, body }) => application.engine.updateSettings(body)
  )
  .patch("/settings", { body: partial(settingsSchema) }, ({ application, body }) =>
    application.engine.updateSettings(body)
  );
