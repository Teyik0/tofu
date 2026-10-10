import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { pluginConfigurationSchema } from "./model";

export const plugins = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(furinSync(sync))
  .use(furinInvalidate())
  .guard({
    invalidate: [
      { path: "/plugins", type: "layout" },
      { path: "/anilist", type: "page" },
    ],
    sync: false,
  })
  .post("/plugins/:id/test", ({ params }) => services.automation.testPlugin(params.id))
  .put(
    "/plugins/:id",
    {
      body: pluginConfigurationSchema,
    },
    ({ params, body }) => services.automation.configure(params.id, body)
  );
