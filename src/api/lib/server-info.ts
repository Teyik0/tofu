import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { engine as torrentEngine } from "../modules/torrents/plugin";
import type { instance as databaseInstance } from "./database-plugin";
import { recordLog } from "./diagnostics";

export async function writeServerInfo(
  instance: typeof databaseInstance,
  engine: typeof torrentEngine,
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
  recordLog({
    component: "application",
    context: { mode: engine.mode, profile: instance.profile },
    dataDir,
    level: "info",
    operation: "ready",
  });
  console.log(`${instance.name} is ready : ${url} (data: ${dataDir})`);
}
