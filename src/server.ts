import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { assertRuntimeReady, onShutdown, onStartup } from "./api/lib/lifecycle";
import { instance, runtime } from "./api/lib/runtime";
import { writeServerInfo } from "./api/lib/server-info";
import { sync } from "./sync";

const app = new Elysia({ serve: { maxRequestBodySize: 9 * 1024 * 1024 } })
  .use(desktopApp({ onShutdown, onStartup, restrictWebToLoopback: true }))
  .setup(async () => {
    await onStartup(new AbortController().signal);
    await assertRuntimeReady();
  })
  .use(await furin({ pagesDir: "./src/pages", sync }))
  .use(apiPlugin);

if (import.meta.main) {
  try {
    await new Promise<void>((resolve, reject) => {
      app.cleanup(() => reject(new Error("Tofu stopped before startup completed")));
      app.listen({ hostname: "127.0.0.1", port: instance.port }, () => resolve());
    });
    await writeServerInfo(`http://127.0.0.1:${app.server?.port}`, undefined);
    const shutdown = async () => {
      await app.stop(true);
      process.exit(0);
    };
    if (runtime.shutdown) {
      process.off("SIGINT", runtime.shutdown);
      process.off("SIGTERM", runtime.shutdown);
    }
    runtime.shutdown = shutdown;
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    await app.stop(true);
    throw error;
  }
}

export default app;
