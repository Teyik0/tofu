import { expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { assertApplicationReady } from "../src/api/lib/lifecycle";
import { WorkerTorrentEngine } from "../src/api/modules/torrents/worker-client";
import { fixture, network } from "./helpers";

test("startup readiness rejects a stopped worker even when its summaries are cached", async () => {
  const context = await fixture(4096, []);
  const engine = await WorkerTorrentEngine.open({
    dataDir: join(context.directory, "worker-state"),
    downloadPath: join(context.directory, "worker-downloads"),
    network,
  });
  try {
    const application = { db: context.sync.db, engine };
    await assertApplicationReady(application);
    await engine.close();
    await expect(assertApplicationReady(application)).rejects.toThrow(
      "The torrent engine is shutting down"
    );
  } finally {
    await engine.close();
    await context.close();
  }
});

test("startup readiness rejects a database missing a required table despite its migration marker", async () => {
  const context = await fixture(4096, []);
  try {
    const application = { db: context.sync.db, engine: context.engine };
    await assertApplicationReady(application);
    context.sync.db.run(sql`DROP TABLE automations`);
    await expect(assertApplicationReady(application)).rejects.toThrow();
  } finally {
    await context.close();
  }
});
