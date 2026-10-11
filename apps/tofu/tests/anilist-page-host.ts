import { join } from "node:path";
import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { AutomationService } from "../src/api/modules/automation/service";
import { createTestApplication, mountTestApplication } from "./api-fixture";
import { fixture } from "./helpers";

const endpoint = process.env.TOFU_TEST_ANILIST_ENDPOINT;
if (!endpoint) {
  throw new Error("The test AniList endpoint is missing");
}
const context = await fixture(4096, []);
const service = await AutomationService.open({
  dataDir: join(context.directory, "feeds"),
  endpoints: {
    anilist: endpoint,
    c411: endpoint,
    jev: endpoint,
    nyaa: endpoint,
    tsundere: endpoint,
  },
  engine: () => context.engine,
  now: Date.now,
});
const application = await createTestApplication(context.engine, context.sync.options, service);
const api = await mountTestApplication(application, { kind: "server" });
const host = new Elysia()
  .use(api)
  .use(await furin({ pagesDir: "./src/pages", sync: application.sync }))
  .listen({ hostname: "127.0.0.1", port: 0 });
process.on("SIGTERM", async () => {
  await host.stop(true);
  await service.close();
  await context.close();
  process.exit(0);
});
process.send?.({ url: host.server?.url.toString() });
