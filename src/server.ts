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
import { sync } from "./sync";

export let { port } = instance;

const app = new Elysia({
  name: "tofu",
  serve: { hostname: "127.0.0.1", idleTimeout: 120, maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(accessPlugin)
  .use(desktopServicePlugin)
  .use((server) =>
    server.decorate((dependencies) => {
      const { access, connections, desktopHooks, torrents, updates } = dependencies;

      ({ port } = connections.listenOptions());

      // Install the desktop host before API and page wrappers.
      server.use(
        desktopApp({
          ...desktopHooks,
          admission: access.admit.bind(access),
          listen: connections.listenOptions.bind(connections),

          async onReady({ backend, signal }) {
            signal.throwIfAborted();

            connections.listened(Number(new URL(backend.origin).port));

            const activated = await connections.activateExposures();

            if (activated instanceof ElysiaStatus) {
              throw new Error(activated.response.detail);
            }

            signal.throwIfAborted();

            await writeServerInfo(instance, torrents, backend.origin, backend.cookie);
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

      return dependencies;
    })
  )
  .use(httpPolicyPlugin)
  .guard({ noStore: true })
  .use(apiPlugin)
  .use(await furin({ logger: { exclude: ["/**"] }, pagesDir: "./src/pages", sync }));

// Furin initializes the process logger during composition; restore Tofu's explicit-event drain.
initLogger({ ...loggerConfig, drain: logs });

if (import.meta.main) {
  app.listen(port);
  const shutdown = async () => {
    try {
      await app.stop(true);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export default app;
