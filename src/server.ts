import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import Elysia from "elysia";
import { apiPlugin } from "./api";
import { applicationHost, hostIntegration } from "./api/lib/host";
import { currentInstanceConfig } from "./api/lib/instance";
import { onReady, onShutdown, onStartup } from "./api/lib/lifecycle";
import { desktopHooks } from "./api/modules/desktop/service";
import { sync } from "./sync";

const app = new Elysia({ serve: { maxRequestBodySize: 9 * 1024 * 1024 } })
  .use(desktopApp({ ...desktopHooks, onReady, onShutdown, onStartup, restrictWebToLoopback: true }))
  .use(apiPlugin)
  .use(await furin({ pagesDir: "./src/pages", sync }));

if (import.meta.main) {
  try {
    const runtime = { kind: "server" } as const;
    const instance = currentInstanceConfig(runtime);
    await onStartup({ runtime, signal: new AbortController().signal });
    await new Promise<void>((resolve, reject) => {
      app.cleanup(() => reject(new Error("Tofu stopped before startup completed")));
      app.listen({ hostname: "127.0.0.1", port: instance.port }, () => resolve());
    });
    await applicationHost.application;
    const shutdown = async () => {
      await app.stop(true);
      process.exit(0);
    };
    if (hostIntegration.tofuShutdown) {
      process.off("SIGINT", hostIntegration.tofuShutdown);
      process.off("SIGTERM", hostIntegration.tofuShutdown);
    }
    hostIntegration.tofuShutdown = shutdown;
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    if (app.server) {
      await app.stop(true);
    } else {
      await onShutdown();
    }
    throw error;
  }
}

export default app;
