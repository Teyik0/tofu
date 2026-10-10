import { join } from "node:path";
import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { runtime } from "../src/api/lib/runtime";
import { services } from "../src/api/lib/services";
import { AutomationService } from "../src/api/modules/automation/service";
import { createTestApi } from "./api-fixture";
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
runtime.automation = service;
services.engine = context.engine;
runtime.db = service.db;
services.syncAdapter = context.sync.options.adapter;
const host = new Elysia()
  .use(
    createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    )
  )
  .use(await furin({ pagesDir: "./src/pages", sync: context.sync.options }))
  .listen({ hostname: "127.0.0.1", port: 0 });
process.on("SIGTERM", async () => {
  await host.stop(true);
  await service.close();
  await context.close();
  process.exit(0);
});
process.send?.({ url: host.server?.url.toString() });
