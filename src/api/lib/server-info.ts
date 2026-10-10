import { rename } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, instance } from "./runtime";
import { services } from "./services";

export async function writeServerInfo(url: string, cookie: string | undefined) {
  await Bun.write(
    join(dataDir, "server.json.tmp"),
    JSON.stringify({
      cookie,
      mode: services.engine.mode,
      pid: process.pid,
      profile: instance.profile,
      url,
    }),
    { mode: 0o600 }
  );
  await rename(join(dataDir, "server.json.tmp"), join(dataDir, "server.json"));
  console.log(`${instance.name} is ready : ${url} (data: ${dataDir})`);
}
