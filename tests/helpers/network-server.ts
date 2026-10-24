import { desktopApp } from "@teyik0/furin-electrobun/server";
import { createContext, Elysia } from "elysia";
import { closeResources } from "../../src/api/lib/lifecycle-plugin";
import { listen } from "../../src/api/lib/network";
import { accessRoutesPlugin } from "../../src/api/modules/access";
import { publicDocumentsPlugin } from "../../src/api/modules/access/documents";
import { accessPlugin } from "../../src/api/modules/access/plugin";

await accessPlugin.modules;
const { access } = createContext(accessPlugin).prototype;

const app = new Elysia({ name: "tofu-network-integration" })
  .use(desktopApp({ admission: access.admit.bind(access) }))
  .onStop(closeResources)
  .use(publicDocumentsPlugin)
  .group("/api", (api) => api.use(accessRoutesPlugin))
  .listen(listen);

process.once("SIGTERM", async () => {
  await app.stop(true);
  process.exit(0);
});
