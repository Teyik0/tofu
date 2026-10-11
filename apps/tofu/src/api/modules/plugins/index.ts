import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import type { PluginCredentialPage } from "../../../types";
import { contextPlugin } from "../../lib/context";
import { UserError } from "../../lib/errors";
import { pluginConfigurationSchema } from "./model";
import { pluginCredentialPages } from "./service";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .post(
    "/plugins/:id/credentials/open",
    { sync: false },
    async ({ application, params }): Promise<PluginCredentialPage> => {
      if (params.id !== "c411" && params.id !== "jev") {
        throw new UserError("This plugin does not use an API key", { status: 400 });
      }
      const url = pluginCredentialPages[params.id];
      if (application.platform.kind !== "desktop") {
        return { opened: false, url };
      }
      const { utils } = application.platform;
      const opened = await Promise.resolve()
        .then(() => utils.openExternal(url))
        .catch(() => false);
      if (!opened) {
        throw new UserError("Unable to open the API key page in your browser", { status: 502 });
      }
      return { opened: true, url };
    }
  )
  .guard({
    invalidate: [
      { path: "/", type: "layout" },
      { path: "/plugins", type: "layout" },
      { path: "/anilist", type: "page" },
    ],
    sync: false,
  })
  .post("/plugins/:id/test", ({ application, params }) =>
    application.automation.testPlugin(params.id)
  )
  .post(
    "/plugins/:id/connect",
    { body: pluginConfigurationSchema },
    ({ application, params, body }) => application.automation.connectPlugin(params.id, body)
  );
