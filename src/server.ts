import { furin } from "@teyik0/furin";
import { ElysiaStatus } from "elysia";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { recordLog } from "./api/lib/diagnostics";
import { onShutdown } from "./api/lib/lifecycle";
import { connections, restoreEmbeddedTransport } from "./api/modules/connections/plugin";
import { sync } from "./sync";

try {
  apiPlugin.use(
    await furin({ logger: { exclude: ["/media/x/**"] }, pagesDir: "./src/pages", sync })
  );
} catch (error) {
  recordLog({
    component: "application",
    dataDir: instance.dataDir,
    error,
    level: "error",
    operation: "startup",
  });
  await apiPlugin.stop(true);
  await onShutdown();
  throw error;
}

/** Furin's compiled boot entry invokes this same lifecycle instead of its generic HTTP listener. */
export async function startServer() {
  try {
    await apiPlugin.modules;
    const listener = connections.listenOptions();
    apiPlugin.listen({ ...listener, port: instance.port });
    connections.ready({
      hostname: listener.hostname,
      port: apiPlugin.server?.port ?? instance.port,
      tls: !!listener.tls,
    });
    const restored = await restoreEmbeddedTransport(apiPlugin.server?.port ?? instance.port);
    if (restored instanceof ElysiaStatus) {
      throw new Error(restored.response.detail);
    }
    const shutdown = async () => {
      await apiPlugin.stop(true);
      process.exit(process.exitCode ?? 0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    recordLog({
      component: "application",
      dataDir: instance.dataDir,
      error,
      level: "error",
      operation: "startup",
    });
    await apiPlugin.stop(true);
    await onShutdown();
    throw error;
  }
}

if (import.meta.main) {
  await startServer();
}

// biome-ignore lint/performance/noBarrelFile: This entry exports the shared application for Furin and the desktop host.
export { apiPlugin as default } from "./api";
