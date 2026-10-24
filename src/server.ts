import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { initLogger, toLoggerConfig, toMiddlewareOptions } from "evlog";
import { config } from "../evlog.config";
import { apiPlugin } from "./api";
import { closeResources } from "./api/lib/lifecycle-plugin";
import { sync } from "./sync";
import { instance } from "./api/lib/instance";

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
  .listen(instance.port);

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
