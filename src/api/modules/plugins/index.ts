import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import type { PluginCredentialPage } from "../../../types";
import { openExternalUrl } from "../../lib/native-opening";
import { runtime } from "../../lib/runtime";
import { accessPlugin } from "../access/plugin";
import { anilistServicePlugin } from "../anilist/plugin";
import { pluginConfigurationSchema, pluginCredentialPages } from "./model";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(furinSync(sync))
  .use(anilistServicePlugin)
  .use(furinInvalidate())
  .use(accessPlugin)
  .guard({ administration: true })
  .post("/plugins/:id/credentials/open", { idempotent: false }, ({ caller, params }) => {
    if (params.id !== "c411" && params.id !== "jev") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const url = pluginCredentialPages[params.id];
    // Only the host's own window opens the host browser; remote callers open it themselves.
    if (caller.kind !== "owner" || runtime.current.kind !== "desktop") {
      return { opened: false, url } satisfies PluginCredentialPage;
    }
    const { shell } = runtime.current.desktop;
    const failed = openExternalUrl(shell, url, "Unable to open the API key page in your browser");
    if (failed) {
      return failed;
    }
    return { opened: true, url } satisfies PluginCredentialPage;
  })
  // Plugin changes alter the dashboard, the plugin pages and the AniList library.
  .onBeforeHandle(({ invalidate }) => {
    invalidate({ path: "/", type: "layout" });
    invalidate({ path: "/plugins", type: "layout" });
    invalidate({ path: "/anilist", type: "page" });
  })
  .post("/plugins/:id/test", async ({ anilist, releaseAutomation, jev, plugins, params }) => {
    if (params.id === "anilist") {
      const listed = await anilist.list();
      if (listed instanceof ElysiaStatus) {
        return listed;
      }
      return releaseAutomation.snapshot();
    }
    if (params.id === "jev") {
      const evaluated = await jev.evaluate(
        { message: "connection test" },
        { connected: { instructions: "Does the message say connection test?", type: "noul" } }
      );
      if (evaluated instanceof ElysiaStatus) {
        return evaluated;
      }
      return releaseAutomation.snapshot();
    }
    const tested = await plugins.test(params.id);
    if (tested instanceof ElysiaStatus) {
      return tested;
    }
    return releaseAutomation.snapshot();
  })
  .post(
    "/plugins/:id/connect",
    { body: pluginConfigurationSchema },
    async ({ plugins, releaseAutomation, params, body }) => {
      const connected = await plugins.connect(params.id, body);
      if (connected instanceof ElysiaStatus) {
        return connected;
      }
      return releaseAutomation.snapshot();
    }
  )
  .put(
    "/plugins/:id",
    { body: pluginConfigurationSchema },
    ({ plugins, anilist, releaseAutomation, params, body }) => {
      const configured = plugins.configure(params.id, body);
      if (configured instanceof ElysiaStatus) {
        return configured;
      }
      if (params.id === "anilist" && !body.enabled) {
        anilist.suspend();
      }
      return releaseAutomation.snapshot();
    }
  );
