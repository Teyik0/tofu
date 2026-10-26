import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { desktopContext } from "@teyik0/furin-electrobun/server";
import { Effect } from "effect";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { nativeControl } from "../../../native/control";
import { sync } from "../../../sync";

import { openExternalUrl } from "../../lib/native-opening";
import { accessPlugin } from "../access/plugin";
import { anilistServicePlugin } from "../anilist/plugin";
import { pluginConfigurationSchema, pluginCredentialPages } from "./model";

export const pluginsPlugin = new Elysia({ name: "tofu-pluginmanagement-api" })
  .use(desktopContext)
  .use(furinSync(sync))
  .use(anilistServicePlugin)
  .use(furinInvalidate())
  .use(accessPlugin)
  .guard({ administration: true })
  .post("/plugins/:id/credentials/open", { idempotent: false }, ({ caller, desktop, params }) => {
    const sdk = nativeControl.tofuNativeSdk;
    if (params.id !== "c411") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const url = pluginCredentialPages[params.id];
    // Only the host's own window opens the host browser; remote callers open it themselves.
    if (caller.kind !== "owner" || !desktop || !sdk) {
      return { opened: false, url };
    }
    const { Utils } = sdk;
    const failed = openExternalUrl(Utils, url, "Unable to open the API key page in your browser");
    if (failed) {
      return failed;
    }
    return { opened: true, url };
  })
  // Plugin changes alter the dashboard, the plugin pages and the AniList library.
  .onBeforeHandle(({ invalidate }) => {
    invalidate("/api/automation");
    invalidate({ path: "/", type: "layout" });
    invalidate({ path: "/plugins", type: "layout" });
    invalidate({ path: "/anilist", type: "page" });
  })
  .post("/plugins/:id/test", async ({ anilist, releaseAutomation, plugins, params }) => {
    if (params.id === "anilist") {
      const listed = await Effect.runPromise(anilist.list());
      if (listed instanceof ElysiaStatus) {
        return listed;
      }
      return releaseAutomation.snapshot();
    }
    const tested = await Effect.runPromise(plugins.test(params.id));
    if (tested instanceof ElysiaStatus) {
      return tested;
    }
    return releaseAutomation.snapshot();
  })
  .post(
    "/plugins/:id/connect",
    { body: pluginConfigurationSchema },
    async ({ plugins, releaseAutomation, params, body }) => {
      const connected = await Effect.runPromise(plugins.connect(params.id, body));
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
