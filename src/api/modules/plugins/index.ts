import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, problem } from "elysia";
import { sync } from "../../../sync";
import type { PluginCredentialPage } from "../../../types";
import { contextPlugin } from "../../lib/context";

import { openExternalUrl } from "../../lib/native-opening";
import { pluginConfigurationSchema } from "./model";
import { pluginCredentialPages } from "./service";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .post("/plugins/:id/credentials/open", { sync: false }, ({ application, params }) => {
    if (params.id !== "c411" && params.id !== "jev") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const url = pluginCredentialPages[params.id];
    if (application.platform.kind !== "desktop") {
      return { opened: false, url } satisfies PluginCredentialPage;
    }
    const { shell } = application.platform.desktop;
    openExternalUrl(shell, url, "Unable to open the API key page in your browser");
    return { opened: true, url } satisfies PluginCredentialPage;
  })
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
  )
  .put(
    "/plugins/:id",
    {
      body: pluginConfigurationSchema,
    },
    ({ application, params, body }) => application.automation.configure(params.id, body)
  );
