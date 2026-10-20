import { furin } from "@teyik0/furin";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { recordLog } from "./api/lib/diagnostics";
import { onShutdown } from "./api/lib/lifecycle";
import { connections } from "./api/modules/connections/plugin";
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
    // The application always listens on loopback HTTP at TOFU_PORT. desktopApp's ready hook
    // records the port and opens the exposures before the listener serves requests.
    apiPlugin.listen(connections.listenOptions());
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
