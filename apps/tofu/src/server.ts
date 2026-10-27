import { furin } from "@teyik0/furin";
import { initLogger, toLoggerConfig, toMiddlewareOptions } from "evlog";
import { config } from "../evlog.config";
import { apiPlugin } from "./api/index";
import { instance } from "./api/lib/instance";
import { sync } from "./sync";

initLogger(toLoggerConfig(config));

const app = apiPlugin.guard({ noStore: true }).use(
  await furin({
    logger: {
      ...toMiddlewareOptions(config),
      exclude: ["/api/**"],
      include: ["/**"],
    },
    pagesDir: "./src/pages",
    sync,
  })
);

export default app;

if (import.meta.main) {
  app.listen({ port: instance.port });

  const shutdown = async () => {
    await app.stop(true);
    process.exit(process.exitCode ?? 0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
