import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { instance } from "../../src/api/lib/instance";
import { servicesRuntime } from "../../src/api/lib/services-runtime";
import { publicDocumentsPlugin } from "../../src/api/modules/access/documents";
import { accessPlugin } from "../../src/api/modules/access/plugin";
import { updatesPlugin } from "../../src/api/modules/updates";

const app = new Elysia({ name: "tofu-updates-integration" })
  .use(accessPlugin)
  .use(desktopApp(({ access }) => ({ admission: access.admit.bind(access) })))
  .use(publicDocumentsPlugin)
  .group("/api", (api) => api.use(updatesPlugin))
  .onStop(() => servicesRuntime.dispose())
  .listen({ hostname: "127.0.0.1", port: instance.port });

process.once("SIGTERM", async () => {
  await app.stop(true);
  process.exit(0);
});
