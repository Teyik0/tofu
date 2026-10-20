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
  import("./modules/access"),
  import("./modules/access/documents"),
  import("./modules/access/plugin"),
  import("./modules/connections/plugin"),
  import("./modules/connections"),
  import("./modules/media-links"),
  import("./modules/library-links"),
  import("./modules/playback"),
  import("./modules/anilist"),
  import("./modules/anilist/opening"),
  import("./modules/automation/management"),
  import("./modules/dashboard"),
  import("./modules/desktop"),
  import("./modules/destinations"),
  import("./modules/destinations/storage"),
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
  { accessRoutesPlugin },
  { publicDocumentsPlugin },
  { access },
  { connections },
  { connectionsPlugin },
  { mediaLinksApiPlugin, mediaLinksPlugin },
  { libraryAvailabilityPlugin, linkedLibrariesPlugin },
  { playbackPlugin },
  { anilistPlugin },
  { anilistOpeningPlugin },
  { automationManagementPlugin },
  { dashboardPlugin },
  { desktopPlugin },
  { destinationsPlugin },
  { storageRootsPlugin },
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
] = await (async () => {
  try {
    return await Promise.all(routeModules);
  } catch (error) {
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
      // biome-ignore lint/style/useErrorCause: The aggregate retains the startup error as cause and the cleanup error as a member.
      throw new AggregateError([error, cleanupError], "Application startup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
})();

export const apiPlugin = new Elysia({
  name: "tofu-api",
  serve: { idleTimeout: 120, maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(
    desktopApp({
      ...desktopHooks,
      // Every listener request is authenticated here, before routing and Furin rendering.
      admission: (request, context) => access.admit(request, context),
      // Remote access needs a stable port; without it the private window keeps a random one.
      listen: () => connections.listenOptions(),
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
    })
  )
  .onRequest(({ request, set }) => {
    const { pathname } = new URL(request.url);
    // Authenticated documents, navigation data and API responses never enter shared caches.
    if (
      (!pathname.startsWith("/_furin/") || pathname === "/_furin/data") &&
      !pathname.startsWith("/api/player/engine/")
    ) {
      set.headers["cache-control"] = "private, no-store";
    }
    // VLC runs in threads that share memory, which requires a cross-origin isolated player page.
    if (pathname.startsWith("/player/") || pathname.startsWith("/api/player/")) {
      set.headers["cross-origin-embedder-policy"] = "require-corp";
      set.headers["cross-origin-opener-policy"] = "same-origin";
      set.headers["cross-origin-resource-policy"] = "same-origin";
    }
  })
  .onError("global", ({ request, error }) => {
    recordLog({
      component: "api",
      context: { method: request.method, path: new URL(request.url).pathname },
      dataDir: instance.dataDir,
      error: error instanceof ValidationError ? new Error("Request validation failed") : error,
      level: "error",
      operation: "request",
    });
  })
  .onAfterResponse("global", ({ request, path, set }) => {
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
  .use(publicDocumentsPlugin)
  .use(mediaLinksPlugin)
  .group("/api", (app) =>
    app
      .use(accessRoutesPlugin)
      .use(connectionsPlugin)
      .use(mediaLinksApiPlugin)
      .use(libraryAvailabilityPlugin)
      .use(linkedLibrariesPlugin)
      .use(playbackPlugin)
      .use(torrentServicePlugin)
      .use(healthPlugin)
      .use(settingsPlugin)
      .use(dashboardPlugin)
      .use(torrentPlugin)
      .use(destinationsPlugin)
      .use(storageRootsPlugin)
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
