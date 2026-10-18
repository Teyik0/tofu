import "@teyik0/furin/server-only";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia, ValidationError } from "elysia";
import { instance as configuredInstance } from "./lib/database-plugin";
import { recordLog } from "./lib/diagnostics";
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
  import("./modules/player"),
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
  { playerPlugin },
  { pluginsPlugin },
  { settingsPlugin },
  { torrentPlugin },
  { engine, torrentServicePlugin },
  { updatesPlugin },
  { instance },
  { updates },
] = await Promise.all(routeModules).catch(async (error: unknown) => {
  recordLog({
    component: "application",
    dataDir: configuredInstance.dataDir,
    error,
    level: "error",
    operation: "startup",
  });
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
  .request(({ request, set }) => {
    const { pathname } = new URL(request.url);
    // VLC runs in threads that share memory, which requires a cross-origin isolated player page.
    if (pathname.startsWith("/player/") || pathname.startsWith("/api/player/")) {
      set.headers["cross-origin-embedder-policy"] = "require-corp";
      set.headers["cross-origin-opener-policy"] = "same-origin";
      set.headers["cross-origin-resource-policy"] = "same-origin";
    }
  })
  .error("global", ({ request, error }) => {
    recordLog({
      component: "api",
      context: { method: request.method, path: new URL(request.url).pathname },
      dataDir: instance.dataDir,
      error: error instanceof ValidationError ? new Error("Request validation failed") : error,
      level: "error",
      operation: "request",
    });
  })
  .afterResponse("global", ({ request, path, set }) => {
    if (
      path.startsWith("/api/") &&
      (!["GET", "HEAD", "OPTIONS"].includes(request.method) ||
        (typeof set.status === "number" && set.status >= 400))
    ) {
      recordLog({
        component: "api",
        context: { method: request.method, path, status: set.status ?? 200 },
        dataDir: instance.dataDir,
        level: typeof set.status === "number" && set.status >= 400 ? "warn" : "info",
        operation: "response",
      });
    }
  })
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
      .use(playerPlugin)
      .use(desktopPlugin)
      .use(updatesPlugin)
  );

export type Api = typeof apiPlugin;
