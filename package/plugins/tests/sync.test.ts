import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FurinSyncOptions } from "@teyik0/furin/sync";
import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite";
import { definePlugin } from "../src/index";
import { createPluginApi, createPluginRuntime } from "../src/server";

test("plugins share the host sync options and publish query invalidations with idempotent mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-sync-"));
  const database = new Database(join(directory, "sync.sqlite"), { create: true });
  migrateSqliteSync(database);
  let principals = 0;
  let updates = 0;
  let disposed = 0;
  const sync: FurinSyncOptions = {
    adapter: sqliteSyncAdapter({ database, namespace: "host" }),
    principal() {
      principals += 1;
      return "host-user";
    },
  };
  const runtime = createPluginRuntime({ sync });
  const identity = { id: "example.settings", scope: {} };
  try {
    await runtime.installDefinition({
      definition: definePlugin({
        api(context) {
          expect(context.sync).toBe(sync);
          return createPluginApi(context)
            .get("/settings", { sync: identity }, () => ({ updates }))
            .patch("/settings", { sync: { invalidate: identity } }, () => {
              updates += 1;
              return { updates };
            });
        },
        id: "example",
        name: "Example",
        setup(context) {
          expect(context.sync).toBe(sync);
          context.scope.onDispose(() => {
            disposed += 1;
          });
        },
        version: "0.0.0",
      }),
      directory,
    });
    await runtime.enable("example");
    const read = await runtime.handle(new Request("http://localhost/api/plugins/example/settings"));
    expect(read.status).toBe(200);
    expect(JSON.parse(read.headers.get("x-furin-query") ?? "null").id).toBe("example.settings");
    const mutate = () =>
      runtime.handle(
        new Request("http://localhost/api/plugins/example/settings", {
          headers: { "Idempotency-Key": "save-once" },
          method: "PATCH",
        })
      );
    const changed = await mutate();
    if (changed.status !== 200) {
      throw new Error(await changed.text());
    }
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ updates: 1 });
    expect(changed.headers.get("x-furin-queries")).toContain("example.settings");
    const replay = await mutate();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ updates: 1 });
    expect(updates).toBe(1);
    expect(principals).toBeGreaterThan(0);
    expect(await sync.adapter.currentCursor()).not.toBe("0");
    await runtime.installDefinition({
      definition: definePlugin({
        api: (context) => createPluginApi(context).get("/ready", () => "ready"),
        id: "other",
        name: "Other",
        version: "0.0.0",
      }),
      directory,
    });
    await runtime.enable("other");
    await runtime.disable("example");
    expect(
      (await runtime.handle(new Request("http://localhost/api/plugins/example/settings"))).status
    ).toBe(404);
    await runtime.enable("example");
    expect(
      await (await runtime.handle(new Request("http://localhost/api/plugins/other/ready"))).text()
    ).toBe("ready");
    const replayAfterRebuild = await mutate();
    expect(replayAfterRebuild.status).toBe(200);
    expect(await replayAfterRebuild.json()).toEqual({ updates: 1 });
    expect(updates).toBe(1);
  } finally {
    await runtime.dispose();
    database.close();
    await rm(directory, { recursive: true });
  }
  expect(disposed).toBe(2);
});

test("sync API helpers reject unavailable host sync options", () => {
  expect(() => createPluginApi({})).toThrow("requires Furin Sync options from its host");
});
