import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { WorkerTorrentEngine } from "../../src/api/modules/torrents/worker-client";
import { createTestApi } from "./application";
import { fixture, network } from "./torrent";

export async function streamingFixture(mode: string, length: number) {
  const resources = new AsyncDisposableStack();
  try {
    const context = await fixture(length, [], "episode.bin");
    resources.defer(context.close);
    const engine =
      mode === "worker"
        ? await WorkerTorrentEngine.open({
            dataDir: join(context.directory, "worker-state"),
            downloadPath: join(context.directory, "worker-downloads"),
            network,
          })
        : context.engine;
    if (mode === "worker") {
      resources.defer(() => engine.close());
    }
    const api =
      mode === "worker" ? await createTestApi(() => engine, context.sync.options) : context.api;
    resources.defer(async () => {
      if (api.server) {
        await api.stop(true);
      }
    });
    return {
      api,
      bytes: context.bytes,
      client: treaty(api).api,
      engine,
      seed: context.seed,
      seeder: context.seeder,
      [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
