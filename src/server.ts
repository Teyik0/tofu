import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { applicationHost, hostIntegration, instance } from "./api/lib/host";
import { onShutdown, onStartup } from "./api/lib/lifecycle";
import { writeServerInfo } from "./api/lib/server-info";
import { apiTransportPlugin } from "./api/lib/transport";
import { sync } from "./sync";

const app = new Elysia({ serve: { maxRequestBodySize: 9 * 1024 * 1024 } })
  .use(desktopApp({ onShutdown, onStartup, restrictWebToLoopback: true }))
  .use(apiTransportPlugin)
  .use(await furin({ pagesDir: "./src/pages", sync }))
  .use(apiPlugin);

if (import.meta.main) {
  try {
    // The web entry must validate resources before opening its listener too.
    await onStartup(new AbortController().signal);
    await new Promise<void>((resolve, reject) => {
      app.cleanup(() => reject(new Error("Tofu stopped before startup completed")));
      app.listen({ hostname: "127.0.0.1", port: instance.port }, () => resolve());
    });
    await writeServerInfo(
      await applicationHost.application,
      `http://127.0.0.1:${app.server?.port}`,
      undefined
    );
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
