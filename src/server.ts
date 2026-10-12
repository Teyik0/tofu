import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { currentInstanceConfig } from "./api/lib/instance";
import { onReady, onShutdown } from "./api/lib/lifecycle";
import { runtime } from "./api/lib/runtime";
import { desktopHooks, desktopRuntime } from "./api/modules/desktop/service";
import { engine } from "./api/modules/torrents/plugin";
import { updates } from "./api/modules/updates/plugin";
import { sync } from "./sync";

const app = new Elysia({
  name: "tofu-server",
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
  .use(await furin({ pagesDir: "./src/pages", sync }))
  .use(apiPlugin);

if (import.meta.main) {
  try {
    await app.modules;
    app.listen({ hostname: "127.0.0.1", port: instance.port });
    const shutdown = async () => {
      await app.stop(true);
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await onShutdown();
    throw error;
  }
}

export default app;
