import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { TorrentEngine } from "../../src/api/modules/torrents/service";
import { createTestApi } from "./application";
import { openTestDatabase } from "./database";
import { network } from "./torrent";
export async function settingsFixture(directory: string) {
  const engine = await TorrentEngine.open({
    dataDir: directory,
    downloadPath: join(directory, "downloads"),
    network,
  });
  const database = await openTestDatabase(directory);
  const api = await createTestApi(() => engine, database.options);
  const client = treaty(api).api;
  return {
    client,
    async close() {
      await database.close();
      await engine.close();
    },
  };
}
