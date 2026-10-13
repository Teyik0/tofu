import "@teyik0/furin/server-only";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { currentInstanceConfig } from "./lib/instance";
import { onReady, onShutdown } from "./lib/lifecycle";
import { resources, runtime } from "./lib/runtime";
import { desktopHooks, desktopRuntime } from "./modules/desktop/service";

const routeModules = [
  import("./modules/anilist"),
  import("./modules/anilist/opening"),
  import("./modules/automation/management"),
  import("./modules/dashboard"),
  import("./modules/desktop"),
  import("./modules/destinations"),
  import("./modules/discovery"),
  import("./modules/health"),
  import("./modules/jev"),
  import("./modules/plugins"),
  import("./modules/settings"),
  import("./modules/torrents"),
  import("./modules/torrents/plugin"),
  import("./modules/updates"),
  import("./lib/database-plugin"),
  import("./modules/updates/plugin"),
] as const;

const [
  { anilistPlugin },
  { anilistOpeningPlugin },
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
      .use(anilistOpeningPlugin)
      .use(automationManagementPlugin)
      .use(discoveryPlugin)
      .use(pluginsPlugin)
      .use(jevManagementPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
  );

export type Api = typeof apiPlugin;
