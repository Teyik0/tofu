// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential user preference changes through the public API.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { createTestApi } from "./helpers/application";
import { expectSuccess } from "./helpers/problem";
import { fixture, network } from "./helpers/torrent";

test("a preference applies independently without overwriting other saved settings", async () => {
  const context = await fixture(1024, []);
  try {
    const initial = expectSuccess(await context.client.settings.get());
    const theme = await context.client.settings.patch({ theme: "dark" });
    expect(theme.status).toBe(200);
    expect(expectSuccess(theme)).toEqual({ ...initial, theme: "dark" });
    const limit = await context.client.settings.patch({ downloadLimit: 128 * 1024 });
    expect(limit.status).toBe(200);
    expect(expectSuccess(limit)).toEqual({ ...initial, downloadLimit: 128 * 1024, theme: "dark" });
    expect(expectSuccess(await context.client.settings.get())).toEqual({
      ...initial,
      downloadLimit: 128 * 1024,
      theme: "dark",
    });
  } finally {
    await context.close();
  }
});
test("concurrent preference changes preserve both updates", async () => {
  const context = await fixture(1024, []);
  try {
    const responses = await Promise.all([
      context.client.settings.patch({ theme: "dark" }),
      context.client.settings.patch({ downloadLimit: 128 * 1024 }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const saved = expectSuccess(await context.client.settings.get());
    expect(saved.theme).toBe("dark");
    expect(saved.downloadLimit).toBe(128 * 1024);
  } finally {
    await context.close();
  }
});
test("appearance defaults to system and a saved theme survives restart and older clients", async () => {
  const context = await fixture(1024, []);
  let reopened: TorrentEngine | undefined;
  try {
    const initial = await context.client.settings.get();
    expect(initial.status).toBe(200);
    expect(expectSuccess(initial).theme).toBe("system");
    const saved = await context.client.settings.put({ ...context.engine.settings, theme: "dark" });
    expect(saved.status).toBe(200);
    expect(expectSuccess(saved).theme).toBe("dark");
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = await createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const client = treaty(app).api;
    const restored = await client.settings.get();
    expect(expectSuccess(restored).theme).toBe("dark");
    const legacy = await client.settings.put({
      downloadLimit: -1,
      downloadPath: reopened.settings.downloadPath,
      uploadLimit: -1,
    });
    expect(expectSuccess(legacy).theme).toBe("dark");
  } finally {
    await reopened?.close();
    await context.close();
  }
});
test("appearance accepts each supported theme and rejects invalid choices without changing preferences", async () => {
  const context = await fixture(1024, []);
  try {
    for (const theme of ["dark", "light", "system"] as const) {
      const response = await context.client.settings.put({ ...context.engine.settings, theme });
      expect(response.status).toBe(200);
      expect(expectSuccess(response).theme).toBe(theme);
    }
    const invalid = await context.client.settings.put({
      ...context.engine.settings,
      theme: "midnight" as never,
    });
    expect(invalid.status).toBe(422);
    const unchanged = await context.client.settings.get();
    expect(expectSuccess(unchanged).theme).toBe("system");
  } finally {
    await context.close();
  }
});
