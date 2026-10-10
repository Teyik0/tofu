import { expect, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../src/api";
import { AutomationService } from "../src/api/feeds/service";
import type { AniListState, AutomationRule } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("AniList library returns artwork, genres, seasons and all list statuses, and remembers the visible statuses", async () => {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as { query: string };
      return Response.json({
        data: body.query.includes("Viewer")
          ? { Viewer: { id: 42, name: "ExampleUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      {
                        media: {
                          bannerImage: "https://example.com/banner.jpg",
                          coverImage: { extraLarge: "https://example.com/cover.jpg" },
                          episodes: 12,
                          format: "TV",
                          genres: ["Action", "Drama"],
                          id: 10,
                          season: "SPRING",
                          seasonYear: 2026,
                          synonyms: [],
                          title: { romaji: "Example" },
                        },
                        progress: 1,
                        status: "CURRENT",
                      },
                      {
                        media: { id: 11, synonyms: [], title: { romaji: "Finished Show" } },
                        progress: 12,
                        status: "COMPLETED",
                      },
                    ],
                  },
                ],
              },
            },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${provider.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    const state = (await (await request("/anilist/list", json({}))).json()) as AniListState;
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({
      bannerImage: "https://example.com/banner.jpg",
      coverImage: "https://example.com/cover.jpg",
      episodes: 12,
      format: "TV",
      genres: ["Action", "Drama"],
      season: "SPRING",
      seasonYear: 2026,
    });
    expect(state.entries[1]).toMatchObject({
      coverImage: null,
      episodes: null,
      genres: [],
      season: null,
    });
    expect(state.visibleStatuses).toEqual(["CURRENT", "PLANNING"]);
    const changed = await request("/anilist/preferences", {
      ...json({ visibleStatuses: ["COMPLETED"] }),
      method: "PUT",
    });
    expect(changed.status).toBe(200);
    await service.close();
    service = await AutomationService.open(options);
    expect((await (await request("/anilist", undefined)).json()).visibleStatuses).toEqual([
      "COMPLETED",
    ]);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});

test("anime episodes offer matching releases, download through real peers and retain a per-anime automation", async () => {
  const context = await fixture(4096, []);
  const provider = Bun.serve({
    async fetch(incoming) {
      if (new URL(incoming.url).pathname === "/anilist") {
        const body = (await incoming.json()) as { query: string };
        return Response.json({
          data: body.query.includes("Viewer")
            ? { Viewer: { id: 42, name: "ExampleUser" } }
            : {
                MediaListCollection: {
                  hasNextChunk: false,
                  lists: [
                    {
                      entries: [
                        {
                          media: { id: 10, synonyms: [], title: { romaji: "Example" } },
                          progress: 0,
                          status: "CURRENT",
                        },
                      ],
                    },
                  ],
                },
              },
        });
      }
      return Response.json({
        entries: [
          {
            episode: 1,
            id: "episode-one",
            infohash: context.seed.infoHash,
            title: "Example S01E01 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
          {
            episode: 1,
            id: "unrelated",
            infohash: "1".repeat(40),
            title: "Different Show S01E01 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${provider.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}/anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    await request("/anilist/list", json({}));
    const found = await request("/anilist/entries/10/releases", json({}));
    expect(found.status).toBe(200);
    expect((await found.json()).releases.map((release: { id: string }) => release.id)).toEqual([
      "episode-one",
    ]);
    await request(
      "/discover/add",
      json({ destinationId: "default", id: "episode-one", paused: false, sourceId: "tsundere" })
    );
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    const downloaded = await (await request("/anilist/entries/10/releases", json({}))).json();
    expect(downloaded.torrents[0].id).toBe(context.seed.infoHash);
    const content = await context.request(
      `/torrents/${context.seed.infoHash}/files/0/content`,
      undefined
    );
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
    const template = await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: 'Download "Example" on Tsundere, VOSTFR 1080p' })
      )
    ).json();
    const saved = await request("/anilist/entries/10/automation", {
      ...json({ ...template, includeExisting: true, resolutions: ["720p", "1080p"] }),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    const rule = (await saved.json()) as AutomationRule;
    expect(rule.aliases).toEqual(["Example"]);
    const updated = await request("/anilist/entries/10/automation", {
      ...json({ ...template, enabled: false, includeExisting: true, languages: ["MULTI"] }),
      method: "PUT",
    });
    expect((await updated.json()).id).toBe(rule.id);
    await request("/anilist/entries/10", { ...json({ enabled: true }), method: "PUT" });
    const subscription = await (
      await request(
        "/anilist/subscriptions",
        json({
          enabled: true,
          intervalMinutes: 15,
          statuses: ["CURRENT"],
          template: { ...template, includeExisting: true },
        })
      )
    ).json();
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const tracked = await (await request("/automation", undefined)).json();
    expect(tracked.automations).toHaveLength(1);
    expect(tracked.automations[0]).toMatchObject({
      enabled: false,
      id: rule.id,
      languages: ["MULTI"],
    });
    await service.close();
    service = await AutomationService.open(options);
    await request("/anilist/list", json({}));
    expect((await (await request("/anilist", undefined)).json()).entries[0].automationId).toBe(
      rule.id
    );
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(1);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});

test("episode completion syncs only consecutive progress and preserves out-of-order episodes across restart", async () => {
  const context = await fixture(1024, []);
  let progress = 0;
  const mutations: number[] = [];
  let reject = false;
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as {
        query: string;
        variables: { progress: number; mediaId: number };
      };
      if (body.query.includes("mutation")) {
        expect(body.variables.mediaId).toBe(10);
        if (reject) {
          return Response.json({ errors: [{ message: "Unavailable" }] });
        }
        ({ progress } = body.variables);
        mutations.push(progress);
        return Response.json({ data: { SaveMediaListEntry: { progress } } });
      }
      return Response.json({
        data: body.query.includes("Viewer")
          ? { Viewer: { id: 42, name: "ExampleUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      {
                        media: { episodes: 3, id: 10, synonyms: [], title: { romaji: "Example" } },
                        progress,
                        status: "CURRENT",
                      },
                    ],
                  },
                ],
              },
            },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${provider.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  const complete = (episode: number, completed: boolean) =>
    request(`/anilist/entries/10/episodes/${episode}`, { ...json({ completed }), method: "PUT" });
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    await request("/anilist/list", json({}));
    expect((await complete(2, true)).status).toBe(200);
    expect(mutations).toEqual([]);
    await service.close();
    service = await AutomationService.open(options);
    await request("/anilist/list", json({}));
    expect(
      (await (await request("/anilist", undefined)).json()).entries[0].completedEpisodes
    ).toEqual([2]);
    expect((await complete(1, true)).status).toBe(200);
    expect(mutations).toEqual([2]);
    reject = true;
    expect((await complete(3, true)).status).toBe(502);
    expect(
      (await (await request("/anilist", undefined)).json()).entries[0].completedEpisodes
    ).toEqual([1, 2]);
    reject = false;
    expect((await complete(1, false)).status).toBe(200);
    expect(mutations).toEqual([2, 0]);
    expect((await complete(4, true)).status).toBe(400);
    await request("/plugins/anilist", { ...json({ apiKey: "", enabled: true }), method: "PUT" });
    expect((await complete(1, true)).status).toBe(409);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});
