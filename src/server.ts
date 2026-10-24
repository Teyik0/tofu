import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { initLogger, toLoggerConfig, toMiddlewareOptions } from "evlog";
import { config } from "../evlog.config";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { closeResources } from "./api/lib/lifecycle-plugin";
import { listen } from "./api/lib/network";
import { sync } from "./sync";

initLogger(toLoggerConfig(config));

const app = new Elysia({ name: "tofu" })
  .use(apiPlugin)
  .use(
    desktopApp(({ access, torrents }) => ({
      admission: access.admit.bind(access),
      background: () => torrents.settings.runInBackground === true,
      window: {
        frame: { height: 940, width: 1400 },
        renderer: "native",
        title: instance.name,
      },
    }))
  )
  .onStop(closeResources)
  .guard({ noStore: true })
  .use(
    await furin({
      logger: {
        ...toMiddlewareOptions(config),
        exclude: ["/api/**"],
        include: ["/**"],
      },
      pagesDir: "./src/pages",
      sync,
    })
  )
  .listen(listen);

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
