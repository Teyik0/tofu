import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { pluginConfigurationSchema } from "./model";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .guard({
    invalidate: [
      { path: "/plugins", type: "layout" },
      { path: "/anilist", type: "page" },
    ],
    sync: false,
  })
  .post("/plugins/:id/test", ({ application, params }) =>
    application.automation.testPlugin(params.id)
  )
  .put(
    "/plugins/:id",
    {
      body: pluginConfigurationSchema,
    },
    ({ application, params, body }) => application.automation.configure(params.id, body)
  );
