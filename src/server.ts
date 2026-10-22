import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia, ElysiaStatus } from "elysia";
import { initLogger } from "evlog";
import { apiPlugin } from "./api";
import { instance, logs } from "./api/lib/database-plugin";
import { loggerConfig } from "./api/lib/diagnostics";
import { httpPolicyPlugin } from "./api/lib/http-policy";
import { currentInstanceConfig } from "./api/lib/instance";
import { runtime } from "./api/lib/runtime";
import { writeServerInfo } from "./api/lib/server-info";
import { accessPlugin } from "./api/modules/access/plugin";
import { desktopServicePlugin } from "./api/modules/desktop/service";
import { nativeControl } from "./native/control";
import { sync } from "./sync";

let { port } = instance;

// Furin configures the process logger during composition; restore Tofu's drain before listening.
initLogger({ ...loggerConfig, drain: logs });

const app = new Elysia({
  name: "tofu",
  serve: { hostname: "127.0.0.1", idleTimeout: 120, maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(accessPlugin)
  .use(desktopServicePlugin)
  .use((app) =>
    app.decorate(({ access, connections, desktopHooks, torrents, updates }) => {
      ({ port } = connections.listenOptions());

      // Install the desktop host before API and page wrappers.
      app.use(
        desktopApp({
          ...desktopHooks,
          admission: access.admit.bind(access),
          listen: connections.listenOptions.bind(connections),

          async onReady({ backend, signal, runtime: applicationRuntime }) {
            signal.throwIfAborted();

            connections.listened(Number(new URL(backend.origin).port));

            const activated = await connections.activateExposures();

            if (activated instanceof ElysiaStatus) {
              throw new Error(activated.response.detail);
            }

            signal.throwIfAborted();

            await writeServerInfo(instance, torrents, backend.origin, backend.cookie);
            nativeControl.tofuNativeHost?.onReady({
              backend,
              runtime: applicationRuntime,
              signal,
            });
          },

          onStartup(context) {
            context.signal.throwIfAborted();

            if (context.runtime.kind === "desktop") {
              const configured = currentInstanceConfig(context.runtime);

              if (
                configured.dataDir !== instance.dataDir ||
                configured.profile !== instance.profile
              ) {
                throw new Error(
                  "The native host and Tofu must use the same instance profile and data directory"
                );
              }
            }

            runtime.current = context.runtime;

            if (context.runtime.kind === "desktop" && instance.profile === "release") {
              const { desktop } = context.runtime;

              updates.attachNative(desktop.updates, (latest) => {
                desktop.notifications.show({
                  body: `Open ${instance.name} to update to the new version.`,
                  title: `${instance.name} : Tofu ${latest} is available`,
                });
              });
            }
          },
        })
      );

      return { access, connections, desktopHooks, torrents, updates }
    })
  )
  .use(httpPolicyPlugin)
  .guard({ noStore: true })
  .use(apiPlugin)
  .use(await furin({ logger: { exclude: ["/**"] }, pagesDir: "./src/pages", sync }))
  .listen(port);

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export default app;
