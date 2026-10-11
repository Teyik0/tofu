import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

async function editorFixture() {
  const context = await fixture(1024, []);
  const media = { episodes: 12, id: 10, synonyms: [], title: { romaji: "Example" } };
  const options = {
    animeList: {
      advancedScoring: ["Story", "Animation"],
      advancedScoringEnabled: true,
      customLists: ["Weekend"],
    },
    scoreFormat: "POINT_3",
  };
  let entry = {
    advancedScores: { Animation: 80, Story: 90 },
    completedAt: { day: null, month: null, year: null },
    customLists: { Weekend: true },
    hiddenFromStatusLists: false,
    id: 100,
    media,
    mediaId: 10,
    notes: "Original notes",
    priority: 0,
    private: false,
    progress: 2,
    repeat: 0,
    score: 3,
    startedAt: { day: null, month: 10, year: 2026 },
    status: "CURRENT",
  };
  const remote: {
    favourite: boolean;
    favouriteWrites: number;
    listed: boolean;
    reject: boolean;
    saves: number;
  } = { favourite: false, favouriteWrites: 0, listed: true, reject: false, saves: 0 };
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as { query: string; variables: Partial<typeof entry> };
      if (remote.reject && body.query.includes("mutation")) {
        return Response.json({ errors: [{ message: "Unavailable" }] });
      }
      if (body.query.includes("mutation ToggleAnimeFavourite")) {
        remote.favourite = !remote.favourite;
        remote.favouriteWrites += 1;
        return Response.json({ data: { ToggleFavourite: { anime: { nodes: [{ id: 10 }] } } } });
      }
      if (body.query.includes("mutation DeleteEntry")) {
        remote.listed = false;
        return Response.json({ data: { DeleteMediaListEntry: { deleted: true } } });
      }
      expect(incoming.headers.get("authorization")).toBe("Bearer token");
      if (body.query.includes("mutation SaveEntry")) {
        remote.saves += 1;
        remote.listed = true;
        entry = { ...entry, ...body.variables, customLists: { Weekend: true } };
        return Response.json({ data: { SaveMediaListEntry: entry } });
      }
      if (body.query.includes("query Editor")) {
        return Response.json({
          data: {
            Media: {
              ...media,
              isFavourite: remote.favourite,
              isFavouriteBlocked: false,
              mediaListEntry: remote.listed ? entry : null,
            },
            Viewer: { id: 42, mediaListOptions: options, name: "ExampleUser" },
          },
        });
      }
      return Response.json({
        data: body.query.includes("query Viewer")
          ? { Viewer: { id: 42, name: "ExampleUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [{ entries: remote.listed ? [entry] : [] }],
              },
            },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${provider.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  await request("/plugins/anilist", { ...json({ apiKey: "token", enabled: true }), method: "PUT" });
  await request("/anilist/list", json({}));
  return {
    bytes: context.bytes,
    close: async () => {
      await service.close();
      provider.stop(true);
      await context.close();
    },
    magnet: context.magnet,
    remote,
    request,
  };
}

test("AniList editor loads account options and saves list fields into the library", async () => {
  const context = await editorFixture();
  try {
    const response = await context.request("/anilist/entries/10/editor", undefined);
    expect(response.status).toBe(200);
    const editor = await response.json();
    expect(editor.options).toEqual({
      advancedScoring: ["Story", "Animation"],
      advancedScoringEnabled: true,
      customLists: ["Weekend"],
      scoreFormat: "POINT_3",
    });
    expect(editor.entry).toMatchObject({
      customLists: ["Weekend"],
      id: 100,
      score: 3,
      startedAt: { day: null, month: 10, year: 2026 },
    });
    const saved = await context.request("/anilist/entries/10/editor", {
      ...json({
        advancedScores: [85, 90],
        completedAt: { day: 11, month: 10, year: 2026 },
        customLists: ["Weekend"],
        hiddenFromStatusLists: true,
        notes: "Updated notes",
        priority: 2,
        private: true,
        progress: 12,
        repeat: 1,
        score: 2,
        startedAt: { day: null, month: 10, year: 2026 },
        status: "COMPLETED",
      }),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    const state = await saved.json();
    expect(state.entries[0]).toMatchObject({ mediaId: 10, progress: 12, status: "COMPLETED" });
    expect(state.entries[0].completedEpisodes).toHaveLength(12);
  } finally {
    await context.close();
  }
});

test("favourites can be added and removed without duplicating a repeated request", async () => {
  const context = await editorFixture();
  try {
    const set = (enabled: boolean) =>
      context.request("/anilist/entries/10/favourite", { ...json({ enabled }), method: "PUT" });
    expect((await set(true)).status).toBe(200);
    expect(await (await set(true)).json()).toEqual({ isFavourite: true });
    expect(context.remote.favouriteWrites).toBe(1);
    expect(await (await set(false)).json()).toEqual({ isFavourite: false });
    context.remote.reject = true;
    expect((await set(true)).status).toBe(502);
    context.remote.reject = false;
    expect(
      (await (await context.request("/anilist/entries/10/editor", undefined)).json()).isFavourite
    ).toBe(false);
  } finally {
    await context.close();
  }
});

test("removing an anime list entry preserves downloaded files and allows adding it again", async () => {
  const context = await editorFixture();
  try {
    const torrent = await context.request(
      "/torrents",
      json({ paused: false, source: context.magnet })
    );
    expect(torrent.status).toBe(200);
    const { id } = await torrent.json();
    await waitFor(
      async () => (await context.request(`/state?selected=${id}`, undefined)).json(),
      (state) => state.detail?.status === "seeding"
    );
    context.remote.reject = true;
    expect((await context.request("/anilist/entries/10/editor", { method: "DELETE" })).status).toBe(
      502
    );
    expect((await (await context.request("/anilist", undefined)).json()).entries).toHaveLength(1);
    context.remote.reject = false;
    expect((await context.request("/anilist/entries/10/editor", { method: "DELETE" })).status).toBe(
      200
    );
    expect((await (await context.request("/anilist", undefined)).json()).entries).toHaveLength(0);
    const editor = await (await context.request("/anilist/entries/10/editor", undefined)).json();
    expect(editor.entry).toBeNull();
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
    const added = await context.request("/anilist/entries/10/editor", {
      ...json({ status: "PLANNING" }),
      method: "PUT",
    });
    expect(added.status).toBe(200);
    expect((await added.json()).entries[0].status).toBe("PLANNING");
  } finally {
    await context.close();
  }
});

test("invalid editor values and rejected writes leave the library unchanged", async () => {
  const context = await editorFixture();
  try {
    const save = (body: object) =>
      context.request("/anilist/entries/10/editor", { ...json(body), method: "PUT" });
    expect((await save({ score: 4 })).status).toBe(400);
    expect((await save({ progress: 13 })).status).toBe(400);
    expect((await save({ customLists: ["Unknown"] })).status).toBe(400);
    expect((await save({ advancedScores: [50] })).status).toBe(400);
    const date = await save({ completedAt: { day: 30, month: 2, year: 2026 } });
    expect([400, 422]).toContain(date.status);
    expect(context.remote.saves).toBe(0);
    context.remote.reject = true;
    expect((await save({ progress: 12, status: "COMPLETED" })).status).toBe(502);
    expect((await (await context.request("/anilist", undefined)).json()).entries[0]).toMatchObject({
      progress: 2,
      status: "CURRENT",
    });
    await context.request("/plugins/anilist", {
      ...json({ apiKey: "", enabled: true }),
      method: "PUT",
    });
    expect((await save({ status: "COMPLETED" })).status).toBe(409);
    expect(
      (
        await context.request("/anilist/entries/10/favourite", {
          ...json({ enabled: true }),
          method: "PUT",
        })
      ).status
    ).toBe(409);
    expect((await context.request("/anilist/entries/10/editor", { method: "DELETE" })).status).toBe(
      409
    );
  } finally {
    await context.close();
  }
});
