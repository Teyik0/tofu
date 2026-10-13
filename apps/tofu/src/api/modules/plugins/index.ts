import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, problem } from "elysia";
import { sync } from "../../../sync";
import type { PluginCredentialPage } from "../../../types";
import { openExternalUrl } from "../../lib/native-opening";
import { runtime } from "../../lib/runtime";
import { anilistServicePlugin } from "../anilist/plugin";
import { pluginConfigurationSchema } from "./model";
import { pluginCredentialPages } from "./service";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(anilistServicePlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .post("/plugins/:id/credentials/open", { sync: false }, ({ params }) => {
    if (params.id !== "c411" && params.id !== "jev") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const url = pluginCredentialPages[params.id];
    if (runtime.current.kind !== "desktop") {
      return { opened: false, url } satisfies PluginCredentialPage;
    }
    const { shell } = runtime.current.desktop;
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
  .post("/plugins/:id/test", async ({ anilist, releaseAutomation, jev, plugins, params }) => {
    if (params.id === "anilist") {
      await anilist.list();
      return releaseAutomation.snapshot();
    }
    if (params.id === "jev") {
      await jev.evaluate(
        { message: "connection test" },
        { connected: { instructions: "Does the message say connection test?", type: "noul" } }
      );
    } else {
      await plugins.test(params.id);
    }
    return releaseAutomation.snapshot();
  })
  .post(
    "/plugins/:id/connect",
    { body: pluginConfigurationSchema },
    async ({ plugins, releaseAutomation, params, body }) => {
      await plugins.connect(params.id, body);
      return releaseAutomation.snapshot();
    }
  )
  .put(
    "/plugins/:id",
    {
      body: pluginConfigurationSchema,
    },
    ({ plugins, anilist, releaseAutomation, params, body }) => {
      plugins.configure(params.id, body);
      if (params.id === "anilist" && !body.enabled) {
        anilist.suspend();
      }
      return releaseAutomation.snapshot();
    }
  );
