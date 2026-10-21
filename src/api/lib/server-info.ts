import { rename } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "evlog";
import type { WorkerTorrentEngine } from "../modules/torrents/worker-client";
import type { instance as databaseInstance } from "./database-plugin";

export async function writeServerInfo(
  instance: typeof databaseInstance,
  engine: WorkerTorrentEngine,
  url: string,
  cookie: string | undefined
) {
  const { dataDir } = instance;
  await Bun.write(
    join(dataDir, "server.json.tmp"),
    JSON.stringify({
      cookie,
      mode: engine.mode,
      pid: process.pid,
      profile: instance.profile,
      url,
    }),
    { mode: 0o600 }
  );
  await rename(join(dataDir, "server.json.tmp"), join(dataDir, "server.json"));
  const log = createLogger({
    component: "application",
    context: { mode: engine.mode, profile: instance.profile },
    dataDir,
    operation: "ready",
  });
  log.emit();
  console.log(`${instance.name} is ready : ${url} (data: ${dataDir})`);
}
