import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAniListClient } from "@tofu/anilist/server/client";
import { databaseMigrationsPlugin } from "./database-migrations";
import { materializePluginRuntime } from "./plugin-packages";

const root = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
await mkdir(runtime, { recursive: true });
const worker = await Bun.build({
  entrypoints: [join(root, "src/api/modules/torrents/worker.ts")],
  external: ["webtorrent", "parse-torrent"],
  naming: "engine-worker.worker",
  outdir: runtime,
  plugins: [databaseMigrationsPlugin],
  target: "bun",
});
if (!worker.success) {
  throw new AggregateError(worker.logs, "Torrent worker build failed");
}
await materializePluginRuntime(root, join(runtime, "plugins"));
await Bun.write(
  join(runtime, "anilist-client.json"),
  JSON.stringify(
    resolveAniListClient(
      process.env.TOFU_RELEASE === "1" ? "release" : "dev",
      process.env.TOFU_ANILIST_CLIENT_ID
    )
  )
);
