import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Elysia, t } from "elysia";
import { db } from "../../src/api/lib/db";
import { instance } from "../../src/api/lib/instance";
import { torrentDestinations } from "../../src/db/schema";

// Prepare the shared file before the real worker opens its own database connection.
migrate(db, { migrationsFolder: join(import.meta.dir, "../../src/db/drizzle") });
const downloadPath = join(instance.dataDir, "downloads");
await mkdir(downloadPath, { recursive: true });
db.insert(torrentDestinations)
  .values({
    autoAddTorrentFilesSince: Date.now(),
    downloadPath,
    id: "default",
    name: "Downloads",
  })
  .run();
const { torrentServicePlugin } = await import("../../src/api/modules/torrents/plugin");

const app = new Elysia()
  .use(torrentServicePlugin)
  .get("/state", ({ torrents }) => torrents.refreshSnapshot(0))
  .get("/torrents/:id", ({ torrents, params }) => torrents.detail(params.id))
  .post("/torrents", { body: t.Object({ source: t.String() }) }, ({ torrents, body }) =>
    torrents.add(body.source, {
      downloadPath,
      paused: false,
    })
  )
  .listen({ hostname: "127.0.0.1", port: 0 });

export type TorrentLifecycleApp = typeof app;

process.send?.({ port: app.server?.port });
process.once("message", async () => {
  await app.stop(true);
  db.$client.close();
  process.disconnect?.();
});
