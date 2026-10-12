import { furin } from "@teyik0/furin";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { onShutdown } from "./api/lib/lifecycle";
import { sync } from "./sync";

try {
  apiPlugin.use(await furin({ pagesDir: "./src/pages", sync }));

  if (import.meta.main) {
    await apiPlugin.modules;
    apiPlugin.listen({ hostname: "127.0.0.1", port: instance.port });
    const shutdown = async () => {
      await apiPlugin.stop(true);
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
} catch (error) {
  await onShutdown();
  throw error;
}

// biome-ignore lint/performance/noBarrelFile: This entry point exports the shared application for Furin and the desktop host.
export { apiPlugin as default } from "./api";
