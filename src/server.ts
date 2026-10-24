import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { createContext, Elysia } from "elysia";
import { initLogger, toLoggerConfig, toMiddlewareOptions } from "evlog";
import { config } from "../evlog.config";
import { apiPlugin } from "./api";
import { instance } from "./api/lib/database-plugin";
import { closeResources } from "./api/lib/lifecycle-plugin";
import { sync } from "./sync";

initLogger(toLoggerConfig(config));

await apiPlugin.modules;
const { access, connections, torrents } = createContext(apiPlugin).prototype;

const app = new Elysia({
  name: "tofu",
  serve: {
    hostname: "127.0.0.1",
    idleTimeout: 120,
    maxRequestBodySize: 9 * 1024 * 1024,
  },
})
  .use(apiPlugin)
  .use(
    desktopApp({
      admission: access.admit.bind(access),
      background: () => torrents.settings.runInBackground === true,
      listen: connections.listenOptions.bind(connections),
      window: {
        frame: { height: 940, width: 1400 },
        renderer: "native",
        title: instance.name,
      },
    })
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
  .listen(connections.listenOptions());

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
