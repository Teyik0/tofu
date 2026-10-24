import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";
import { Database, databaseLayer } from "../../src/api/lib/database-layer";
import { instance } from "../../src/api/lib/instance";
import { torrentDestinations } from "../../src/db/schema";

// Prepare the shared file before the real worker opens its own database connection.
const seedRuntime = ManagedRuntime.make(databaseLayer);
const db = await seedRuntime.runPromise(Database);
const downloadPath = join(instance.dataDir, "downloads");
await mkdir(downloadPath, { recursive: true });
db.insert(torrentDestinations)
  .values({
    autoAddTorrentFilesSince: Date.now(),
    deleteTorrentFileAfterAdd: true,
    downloadPath,
    id: "default",
    name: "Downloads",
  })
  .run();
await seedRuntime.dispose();
const NativeWorker = globalThis.Worker;
let crashNextCall = false;
// Fail at the native boundary after the RPC client has reserved its pending call.
globalThis.Worker = class extends NativeWorker {
  postMessage(message: unknown) {
    if (crashNextCall) {
      crashNextCall = false;
      this.terminate();
      return;
    }
    super.postMessage(message);
  }
};
const { torrentServicePlugin } = await import("../../src/api/modules/torrents/plugin");
const { servicesRuntime } = await import("../../src/api/lib/services-runtime");

const app = new Elysia()
  .onStop(() => servicesRuntime.dispose())
  .use(torrentServicePlugin)
  .post("/crash", () => {
    crashNextCall = true;
    return { ok: true };
  })
  .get("/state", ({ torrents }) => torrents.refreshSnapshot(0))
  .get("/torrents/:id", ({ torrents, params }) => torrents.call("detail", [params.id]))
  .post(
    "/torrents/:id/peers",
    { body: t.Object({ peer: t.String() }) },
    ({ torrents, params, body }) => torrents.call("addPeer", [params.id, body.peer])
  )
  .post("/torrents", { body: t.Object({ source: t.String() }) }, ({ torrents, body }) =>
    torrents.call("add", [
      body.source,
      {
        downloadPath,
        paused: false,
      },
    ])
  )
  .listen({ hostname: "127.0.0.1", port: 0 });

export type TorrentLifecycleApp = typeof app;

process.send?.({ port: app.server?.port });
process.once("message", async () => {
  await app.stop(true);
  process.disconnect?.();
});
