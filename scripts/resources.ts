import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAniListClient } from "../src/api/modules/anilist/client";
import { databaseMigrationsPlugin } from "./database-migrations";

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
const protocol = await Bun.build({
  entrypoints: [join(root, "scripts/desktop-protocol.ts")],
  outdir: runtime,
  target: "bun",
});
if (!protocol.success) {
  throw new AggregateError(protocol.logs, "Protocol helper build failed");
}
await Bun.write(
  join(runtime, "anilist-client.json"),
  JSON.stringify(
    resolveAniListClient(
      process.env.TOFU_RELEASE === "1" ? "release" : "dev",
      process.env.TOFU_ANILIST_CLIENT_ID
    )
  )
);
