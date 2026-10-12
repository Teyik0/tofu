import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { resources } from "./lib/runtime";

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
  { torrentServicePlugin },
  { updatesPlugin },
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

export const apiPlugin = new Elysia({ name: "tofu-api" }).group("/api", (app) =>
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
