import { pathToFileURL } from "node:url";
import { furin } from "@teyik0/furin";
import { desktopApp, getApplicationRuntime } from "@teyik0/furin-electrobun/server";
import { Elysia, ElysiaStatus } from "elysia";
import { createLogger, initLogger } from "evlog";
import { loggerConfig, sanitizeLog } from "./api/lib/diagnostics";
import { currentInstanceConfig } from "./api/lib/instance";
import { closeResources, reserveInitialization } from "./api/lib/lifecycle-plugin";
import { runtime } from "./api/lib/runtime";
import { writeServerInfo } from "./api/lib/server-info";
import { torrentOpenings } from "./api/modules/desktop/service";
import { nativeControl } from "./native/control";

await using startup = new AsyncDisposableStack();
startup.defer(closeResources);

let apiModule: typeof import("./api");
try {
  apiModule = await import("./api");
} catch (error) {
  const log = createLogger({
    component: "application",
    error: sanitizeLog(error),
    operation: "startup",
  });
  log.setLevel("error");
  log.emit();
  throw error;
}
const { apiPlugin } = apiModule;
const { instance, logs } = await import("./api/lib/database-plugin");
const { sync } = await import("./sync");

let listenOptions = { hostname: "127.0.0.1" as const, port: instance.port };

const app = new Elysia({
  name: "tofu",
  serve: { hostname: "127.0.0.1", idleTimeout: 120, maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(apiPlugin)
  .use((application) =>
    application.decorate((dependencies) => {
      const { access, anilist, connections, releaseAutomation, torrents, updates } = dependencies;
      listenOptions = connections.listenOptions();
      application
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate native identity and initialize dependent resources in order.
        .onStart(async () => {
          using _initialization = reserveInitialization();
          const applicationRuntime = getApplicationRuntime(application);
          const signal =
            applicationRuntime.kind === "desktop" ? applicationRuntime.signal : undefined;
          signal?.throwIfAborted();
          runtime.current = applicationRuntime;
          nativeControl.tofuNativeUpdates = updates;

          if (applicationRuntime.kind === "desktop") {
            const configured = currentInstanceConfig(applicationRuntime);
            if (
              configured.dataDir !== instance.dataDir ||
              configured.profile !== instance.profile
            ) {
              throw new Error(
                "The native host and Tofu must use the same instance profile and data directory"
              );
            }
            const sdk = nativeControl.tofuNativeSdk;
            if (!sdk) {
              throw new Error("The native Tofu integrations were not initialized");
            }
            if (instance.profile === "release") {
              updates.attachNative(
                sdk.Updater,
                applicationRuntime.desktop.updates.install,
                (latest) => {
                  sdk.Utils.showNotification({
                    body: `Open ${instance.name} to update to the new version.`,
                    title: `${instance.name} : Tofu ${latest} is available`,
                  });
                }
              );
            }
          }

          const { server } = application;
          if (!server?.port) {
            throw new Error("The Tofu listener is unavailable during startup");
          }
          connections.listened(server.port);
          await connections.start();
          signal?.throwIfAborted();
          const activated = await connections.activateExposures();
          if (activated instanceof ElysiaStatus) {
            throw new Error(activated.response.detail);
          }
          signal?.throwIfAborted();
          updates.start();
          const started = await Promise.allSettled([anilist.start(), releaseAutomation.start()]);
          const failures = started.filter((result) => result.status === "rejected");
          if (failures.length > 0) {
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Tofu could not start its background services"
            );
          }
          signal?.throwIfAborted();
          await writeServerInfo(
            instance,
            torrents,
            `${server.url.protocol}//127.0.0.1:${server.port}`
          );
        })
        .onStop(closeResources)
        .use(
          desktopApp({
            admission: access.admit.bind(access),
            background: () => torrents.settings.runInBackground === true,
            listen: connections.listenOptions.bind(connections),
            // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep native input validation and error handling at the event boundary.
            async onOpen({ event, desktop, identity }) {
              try {
                if (await nativeControl.tofuNativeHost?.onOpen({ desktop, event, identity })) {
                  return;
                }
                if (
                  event.type === "url" &&
                  ["tofu:", "tofu-dev:"].includes(new URL(event.url).protocol)
                ) {
                  desktop.open();
                  const result = await anilist.receiveAuthorizationUrl(event.url);
                  if (result instanceof ElysiaStatus) {
                    await nativeControl.tofuNativeSdk?.Utils.showMessageBox({
                      detail: result.response.detail,
                      message: "Unable to open link",
                      title: identity.name,
                      type: "error",
                    });
                  }
                  return;
                }
                const opened = await torrentOpenings.stage(
                  event.type === "file" ? pathToFileURL(event.path).href : event.url,
                  torrents
                );
                desktop.open();
                if (opened instanceof ElysiaStatus) {
                  await nativeControl.tofuNativeSdk?.Utils.showMessageBox({
                    detail: opened.response.detail,
                    message: "Unable to open link",
                    title: identity.name,
                    type: "error",
                  });
                }
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message ===
                    "AniList authorization was declined. Connect again when you are ready."
                ) {
                  return;
                }
                await nativeControl.tofuNativeSdk?.Utils.showMessageBox({
                  detail: error instanceof Error ? error.message : "Unexpected error",
                  message: "Unable to open link",
                  title: identity.name,
                  type: "error",
                });
              }
            },
            window: {
              frame: { height: 940, width: 1400 },
              renderer: "native",
              title: instance.name,
            },
          })
        );
      return dependencies;
    })
  )
  .guard({ noStore: true })
  .use(await furin({ logger: { exclude: ["/**"] }, pagesDir: "./src/pages", sync }));

// Furin configures the process logger during composition; restore Tofu's drain before listening.
initLogger({ ...loggerConfig, drain: logs });

if (import.meta.main) {
  await app.modules;
  app.listen(listenOptions);
}

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
