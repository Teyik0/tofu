import { rename } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, getEngine, instance } from "./runtime";

export async function writeServerInfo(url: string, cookie: string | undefined) {
  await Bun.write(
    join(dataDir, "server.json.tmp"),
    JSON.stringify({
      cookie,
      mode: getEngine().mode,
      pid: process.pid,
      profile: instance.profile,
      url,
    }),
    { mode: 0o600 }
  );
  await rename(join(dataDir, "server.json.tmp"), join(dataDir, "server.json"));
  console.log(`${instance.name} is ready : ${url} (data: ${dataDir})`);
}
