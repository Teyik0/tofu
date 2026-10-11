import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { AutomationService } from "../../src/api/modules/automation/service";
import { pluginEndpoints } from "../../src/api/modules/plugins/service";
import { createTestApi } from "./application";
import { fixture } from "./torrent";
export async function credentialsFixture(
  fetch: (request: Request) => Response | Promise<Response>
) {
  const context = await fixture(1024, []);
  const upstream = Bun.serve({ fetch, hostname: "127.0.0.1", port: 0 });
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { ...pluginEndpoints, c411: upstream.url.href, jev: upstream.url.href },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  return {
    client,
    async close() {
      await service.close();
      upstream.stop(true);
      await context.close();
    },
  };
}
