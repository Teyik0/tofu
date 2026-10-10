import { expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { assertRuntimeReady } from "../src/api/lib/lifecycle";
import { runtime } from "../src/api/lib/runtime";
import { WorkerTorrentEngine } from "../src/api/modules/torrents/worker-client";
import { fixture, network } from "./helpers";

test.each(["engine", "database"])(
  "startup readiness requires the %s to be initialized",
  async (resource) => {
    const context = await fixture(4096, []);
    const previousEngine = runtime.engine;
    const previousDatabase = runtime.db;
    runtime.engine = resource === "engine" ? undefined : context.engine;
    runtime.db = resource === "database" ? undefined : context.sync.db;
    try {
      await expect(assertRuntimeReady()).rejects.toThrow("has not been initialized");
    } finally {
      runtime.engine = previousEngine;
      runtime.db = previousDatabase;
      await context.close();
    }
  }
);

test("startup readiness rejects a stopped worker even when its summaries are cached", async () => {
  const context = await fixture(4096, []);
  const engine = await WorkerTorrentEngine.open({
    dataDir: join(context.directory, "worker-state"),
    downloadPath: join(context.directory, "worker-downloads"),
    network,
  });
  const previousEngine = runtime.engine;
  const previousDatabase = runtime.db;
  runtime.engine = engine;
  runtime.db = context.sync.db;
  try {
    await assertRuntimeReady();
    await engine.close();
    await expect(assertRuntimeReady()).rejects.toThrow("The torrent engine is shutting down");
  } finally {
    runtime.engine = previousEngine;
    runtime.db = previousDatabase;
    await engine.close();
    await context.close();
  }
});

test("startup readiness rejects a database missing a required table despite its migration marker", async () => {
  const context = await fixture(4096, []);
  const previousEngine = runtime.engine;
  const previousDatabase = runtime.db;
  runtime.engine = context.engine;
  runtime.db = context.sync.db;
  try {
    await assertRuntimeReady();
    context.sync.db.run(sql`DROP TABLE automations`);
    await expect(assertRuntimeReady()).rejects.toThrow();
  } finally {
    runtime.engine = previousEngine;
    runtime.db = previousDatabase;
    await context.close();
  }
});
