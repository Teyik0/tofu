import { createClient } from "@teyik0/furin/client";
import { bindAniListClients } from "@tofu/anilist/server-clients";
import { extensionsPlugin } from "./extensions-api";
import { pluginHost } from "./lib/extensions";
import "@teyik0/furin/server-only";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { currentInstanceConfig } from "./lib/instance";
import { onReady, onShutdown } from "./lib/lifecycle";
import { resources, runtime } from "./lib/runtime";
import { desktopHooks, desktopRuntime } from "./modules/desktop/service";

const routeModules = [
  import("./modules/anilist"),
  import("./modules/automation/management"),
  import("./modules/dashboard/index"),
  import("./modules/desktop/index"),
  import("./modules/destinations/index"),
  import("./modules/discovery/index"),
  import("./modules/health/index"),
  import("./modules/jev/index"),
  import("./modules/plugins/index"),
  import("./modules/settings/index"),
  import("./modules/torrents/index"),
  import("./modules/torrents/plugin"),
  import("./modules/updates/index"),
  import("./lib/database-plugin"),
  import("./modules/updates/plugin"),
] as const;

const [
  { anilistPlugin },
  { automationManagementPlugin },
  { dashboardPlugin },
  { desktopPlugin },
  { destinationsPlugin },
  { discoveryPlugin },
  { healthPlugin },
  { jevManagementPlugin },
  { pluginsPlugin },
  { settingsPlugin },
  { torrentPlugin },
  { engine, torrentServicePlugin },
  { updatesPlugin },
  { instance },
  { updates },
] = await Promise.all(routeModules).catch(async (error: unknown) => {
  await Promise.allSettled(routeModules);
  try {
    await resources.disposeAsync();
  } catch (cleanupError) {
    // biome-ignore lint/style/useErrorCause: The cause is an AggregateError containing both failures.
    throw new Error("Application startup and cleanup failed", {
      cause: new AggregateError([error, cleanupError], "Startup and cleanup errors"),
    });
  }
  throw error;
});

export const apiPlugin = new Elysia({
  name: "tofu-api",
  serve: { maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(
    desktopApp({
      ...desktopHooks,
      onReady,
      onShutdown,
      onStartup(context) {
        context.signal.throwIfAborted();
        if (context.runtime.kind === "desktop") {
          const configured = currentInstanceConfig(context.runtime);
          if (configured.dataDir !== instance.dataDir || configured.profile !== instance.profile) {
            throw new Error(
              "The native host and Tofu must use the same instance profile and data directory"
            );
          }
        }
        runtime.current = context.runtime;
        desktopRuntime.engine = engine;
        if (context.runtime.kind === "desktop" && instance.profile === "release") {
          const { desktop } = context.runtime;
          updates.attachNative(desktop.updates, (latest) => {
            desktop.notifications.show({
              body: `Open ${instance.name} to update to the new version.`,
              title: `${instance.name} : Tofu ${latest} is available`,
            });
          });
        }
        context.signal.throwIfAborted();
      },
      restrictWebToLoopback: true,
    })
  )
  .group("/api", (app) =>
    app
      .use(torrentServicePlugin)
      .use(healthPlugin)
      .use(settingsPlugin)
      .use(dashboardPlugin)
      .use(torrentPlugin)
      .use(destinationsPlugin)
      .use(anilistPlugin)
      .use(extensionsPlugin)
      .use(automationManagementPlugin)
      .use(discoveryPlugin)
      .use(pluginsPlugin)
      .use(jevManagementPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
      .guard({ sync: false }, (routes) =>
        routes.mount("/plugins", (request) => {
          const url = new URL(request.url);
          url.pathname = `/api/plugins${url.pathname === "/" ? "" : url.pathname}`;
          return pluginHost.handle(new Request(url, request));
        })
      )
  );

export type Api = typeof apiPlugin;

bindAniListClients({ api: createClient(apiPlugin).api, coreClient: createClient(apiPlugin).api });
