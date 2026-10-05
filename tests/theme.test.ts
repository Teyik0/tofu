// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential user preference changes through the public API.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../src/server/api";
import { TorrentEngine } from "../src/server/engine";
import { fixture, json, network } from "./helpers";

test("appearance defaults to system and a saved theme survives restart and older clients", async () => {
  const context = await fixture(1024, []);
  let reopened: TorrentEngine | undefined;
  try {
    const initial = await context.request("/settings", undefined);
    expect(initial.status).toBe(200);
    expect((await initial.json()).theme).toBe("system");
    const saved = await context.request("/settings", {
      ...json({ ...context.engine.settings, theme: "dark" }),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).theme).toBe("dark");
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = createApi(() => reopened as TorrentEngine, context.sync.options);
    const restored = await app.handle(new Request("http://localhost/api/settings"));
    expect((await restored.json()).theme).toBe("dark");
    const legacy = await app.handle(
      new Request("http://localhost/api/settings", {
        ...json({
          downloadLimit: -1,
          downloadPath: reopened.settings.downloadPath,
          uploadLimit: -1,
        }),
        method: "PUT",
      })
    );
    expect((await legacy.json()).theme).toBe("dark");
  } finally {
    await reopened?.close();
    await context.close();
  }
});

test("appearance accepts each supported theme and rejects invalid choices without changing preferences", async () => {
  const context = await fixture(1024, []);
  try {
    for (const theme of ["dark", "light", "system"]) {
      const response = await context.request("/settings", {
        ...json({ ...context.engine.settings, theme }),
        method: "PUT",
      });
      expect(response.status).toBe(200);
      expect((await response.json()).theme).toBe(theme);
    }
    const invalid = await context.request("/settings", {
      ...json({ ...context.engine.settings, theme: "midnight" }),
      method: "PUT",
    });
    expect(invalid.status).toBe(422);
    const unchanged = await context.request("/settings", undefined);
    expect((await unchanged.json()).theme).toBe("system");
  } finally {
    await context.close();
  }
});
