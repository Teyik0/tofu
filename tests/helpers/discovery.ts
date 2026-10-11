import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { AutomationService } from "../../src/api/modules/automation/service";
import { createTestApi } from "./application";
import { fixture } from "./torrent";
export async function discoveryFixture(
  upstreamFetch: (request: Request) => Response | Promise<Response>
) {
  const context = await fixture(1024, []);
  const upstream = Bun.serve({ fetch: upstreamFetch, hostname: "127.0.0.1", port: 0 });
  const base = upstream.url.href;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: `${base}anilist`,
      c411: base,
      jev: `${base}jev`,
      nyaa: `${base}nyaa`,
      tsundere: base,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  await client.plugins({ id: "jev" }).put({ apiKey: "test-jev", enabled: true });
  await client.plugins({ id: "nyaa" }).put({ enabled: true });
  return {
    client,
    async close() {
      await service.close();
      upstream.stop(true);
      await context.close();
    },
  };
}
