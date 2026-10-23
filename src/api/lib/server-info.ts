import { rename } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "evlog";
import type { WorkerTorrentEngine } from "../modules/torrents/worker-client";
import type { instance as databaseInstance } from "./database-plugin";
import type { InstanceProfile } from "./instance";

export async function writeServerInfo(
  instance: typeof databaseInstance,
  engine: WorkerTorrentEngine,
  url: string
) {
  const { dataDir } = instance;
  await Bun.write(
    join(dataDir, "server.json.tmp"),
    JSON.stringify({
      mode: engine.mode,
      pid: process.pid,
      profile: instance.profile,
      url,
    } satisfies ServerInfo),
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

export interface ServerInfo {
  mode: "desktop" | "server";
  pid: number;
  profile: InstanceProfile;
  url: string;
}
