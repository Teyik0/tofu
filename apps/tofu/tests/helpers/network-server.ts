import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { instance } from "../../src/api/lib/instance";
import { publicDocumentsPlugin } from "../../src/api/modules/access/documents";
import { accessRoutesPlugin } from "../../src/api/modules/access/index";
import { accessPlugin } from "../../src/api/modules/access/plugin";

const app = new Elysia({ name: "tofu-network-integration" })
  .use(accessPlugin)
  .use(desktopApp(({ access }) => ({ admission: access.admit.bind(access) })))
  .use(publicDocumentsPlugin)
  .group("/api", (api) => api.use(accessRoutesPlugin))
  .listen({ hostname: "127.0.0.1", port: instance.port });

process.once("SIGTERM", async () => {
  await app.stop(true);
  process.exit(0);
});
