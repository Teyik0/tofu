import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { services } from "../src/api/lib/services";
import { dashboard } from "../src/api/modules/dashboard";
import { settings } from "../src/api/modules/settings";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("feature plugins use their parent's prefix and read the running engine", async () => {
  const context = await fixture(4096, []);
  const previousEngine = services.engine;
  services.engine = context.engine;
  try {
    const app = new Elysia({ prefix: "/fixture" }).use(settings).use(dashboard);
    const preferences = await app.handle(new Request("http://localhost/fixture/settings"));
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toEqual(context.engine.settings);
    const state = await app.handle(new Request("http://localhost/fixture/state?detail=false"));
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual(context.engine.snapshot(null, false));
    expect((await app.handle("http://localhost/fixture/api/settings")).status).toBe(404);
    expect((await context.api.handle("http://localhost/api/health")).status).toBe(200);
    expect((await context.api.handle("http://localhost/api/api/health")).status).toBe(404);
    expect((await context.api.handle("http://localhost/health")).status).toBe(404);
  } finally {
    services.engine = previousEngine;
    await context.close();
  }
});

test("concurrent fixture requests keep transfers and preferences isolated with shared plugins", async () => {
  const first = await fixture(65_536, []);
  const second = await fixture(65_536, []);
  try {
    const [firstAdded, secondAdded] = await Promise.all([
      first.request("/torrents", json({ paused: false, source: first.magnet })),
      second.request("/torrents", json({ paused: false, source: second.magnet })),
    ]);
    expect(firstAdded.status).toBe(200);
    expect(secondAdded.status).toBe(200);
    const [firstTorrent, secondTorrent] = await Promise.all([
      firstAdded.json(),
      secondAdded.json(),
    ]);
    const read = async (context: typeof first, id: string) =>
      (await (await context.request(`/state?selected=${id}`, undefined)).json()) as DashboardState;
    const [firstState, secondState] = await Promise.all([
      waitFor(
        () => read(first, firstTorrent.id),
        (state) => state.detail?.status === "seeding"
      ),
      waitFor(
        () => read(second, secondTorrent.id),
        (state) => state.detail?.status === "seeding"
      ),
    ]);
    expect(firstState.settings.downloadPath).toBe(first.engine.settings.downloadPath);
    expect(secondState.settings.downloadPath).toBe(second.engine.settings.downloadPath);
    expect(firstState.torrents.map((torrent) => torrent.id)).toEqual([firstTorrent.id]);
    expect(secondState.torrents.map((torrent) => torrent.id)).toEqual([secondTorrent.id]);
    const [firstFile, secondFile] = await Promise.all([
      first.request(`/torrents/${firstTorrent.id}/files/0/content`, undefined),
      second.request(`/torrents/${secondTorrent.id}/files/0/content`, undefined),
    ]);
    expect(await firstFile.bytes()).toEqual(first.bytes);
    expect(await secondFile.bytes()).toEqual(second.bytes);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
