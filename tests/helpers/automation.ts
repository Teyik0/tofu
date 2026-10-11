import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { AutomationService } from "../../src/api/modules/automation/service";
import { createTestApi } from "./application";
import type { fixture } from "./torrent";
export async function automationFixture(
  directory: string,
  context: Awaited<ReturnType<typeof fixture>>,
  endpoint: string
) {
  const base = endpoint;
  const service = await AutomationService.open({
    dataDir: join(directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  return { client: treaty(api).api, service };
}
