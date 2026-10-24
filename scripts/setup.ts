import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAniListClient } from "../src/api/modules/anilist/client";

const root = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
await mkdir(runtime, { recursive: true });
const worker = await Bun.build({
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  entrypoints: [join(root, "src/api/modules/torrents/worker.ts")],
  external: ["webtorrent", "parse-torrent"],
  naming: "engine-worker.worker",
  outdir: runtime,
  target: "bun",
});
if (!worker.success) {
  throw new AggregateError(worker.logs, "Torrent worker build failed");
}
await cp(join(root, "src/db/drizzle"), join(runtime, "drizzle"), { recursive: true });
await Bun.write(
  join(runtime, "anilist-client.json"),
  JSON.stringify(
    resolveAniListClient(
      process.env.NODE_ENV === "production" ? "release" : "dev",
      process.env.TOFU_ANILIST_CLIENT_ID
    )
  )
);

await import("./build-tsnet");
