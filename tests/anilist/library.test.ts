import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { AutomationService } from "../../src/api/modules/automation/service";
import type { AniListState, AutomationRule } from "../../src/types";
import { createTestApi } from "../helpers/application";
import { expectSuccess } from "../helpers/problem";
import { fixture, torrentBytes, waitFor } from "../helpers/torrent";

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
                          coverImage: {
                            color: "#a4ce5b",
                            extraLarge: "https://example.com/cover.jpg",
                          },
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
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    const state = expectSuccess(await client.anilist.list.post({})) as AniListState;
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({
      bannerImage: "https://example.com/banner.jpg",
      coverColor: "#a4ce5b",
      coverImage: "https://example.com/cover.jpg",
      episodes: 12,
      format: "TV",
      genres: ["Action", "Drama"],
      season: "SPRING",
      seasonYear: 2026,
    });
    expect(state.entries[1]).toMatchObject({
      coverColor: null,
      coverImage: null,
      episodes: null,
      genres: [],
      season: null,
    });
    expect(state.visibleStatuses).toEqual(["CURRENT", "PLANNING"]);
    const changed = await client.anilist.preferences.put({ visibleStatuses: ["COMPLETED"] });
    expect(changed.status).toBe(200);
    await service.close();
    service = await AutomationService.open(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    expect(expectSuccess(await client.anilist.get()).visibleStatuses).toEqual(["COMPLETED"]);
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
            title: "Example S01E01 VOSTFR 1080p x264",
            torrentUrl: context.magnet,
          },
          {
            episode: 1,
            id: "unrelated",
            infohash: "1".repeat(40),
            title: "Different Show S01E01 VOSTFR 1080p x264",
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
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    await client.anilist.list.post({});
    const found = await client.anilist.entries({ mediaId: "10" }).releases.post({});
    expect(found.status).toBe(200);
    expect(expectSuccess(found).releases.map((release: { id: string }) => release.id)).toEqual([
      "episode-one",
    ]);
    await client.discover.add.post({
      destinationId: "default",
      id: "episode-one",
      paused: false,
      sourceId: "tsundere",
    });
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (state) => state.detail?.status === "seeding"
    );
    const downloaded = expectSuccess(
      await client.anilist.entries({ mediaId: "10" }).releases.post({})
    );
    expect(downloaded.torrents[0]?.id).toBe(context.seed.infoHash);
    const content = await context.client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
    const template = expectSuccess(
      await client.automations.interpret.post({
        destinationId: "default",
        query: 'Download "Example" on Tsundere, VOSTFR 1080p',
      })
    );
    const saved = await client.anilist
      .entries({ mediaId: "10" })
      .automation.put({ ...template, includeExisting: true, resolutions: ["720p", "1080p"] });
    expect(saved.status).toBe(200);
    const rule = expectSuccess(saved) as AutomationRule;
    expect(rule.aliases).toEqual(["Example"]);
    const updated = await client.anilist
      .entries({ mediaId: "10" })
      .automation.put({ ...template, enabled: false, includeExisting: true, languages: ["MULTI"] });
    expect(expectSuccess(updated).id).toBe(rule.id);
    await client.anilist.entries({ mediaId: "10" }).put({ enabled: true });
    const subscription = expectSuccess(
      await client.anilist.subscriptions.post({
        enabled: true,
        intervalMinutes: 15,
        statuses: ["CURRENT"],
        template: { ...template, includeExisting: true },
      })
    );
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const tracked = expectSuccess(await client.automation.get());
    expect(tracked.automations).toHaveLength(1);
    expect(tracked.automations[0]).toMatchObject({
      enabled: false,
      id: rule.id,
      languages: ["MULTI"],
    });
    await service.close();
    service = await AutomationService.open(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    await client.anilist.list.post({});
    expect(expectSuccess(await client.anilist.get()).entries[0]?.automationId).toBe(rule.id);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(1);
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
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    await client.anilist.list.post({});
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 2 })
          .put({ completed: true })
      ).status
    ).toBe(200);
    expect(mutations).toEqual([]);
    await service.close();
    service = await AutomationService.open(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    await client.anilist.list.post({});
    expect(expectSuccess(await client.anilist.get()).entries[0]?.completedEpisodes).toEqual([2]);
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 1 })
          .put({ completed: true })
      ).status
    ).toBe(200);
    expect(mutations).toEqual([2]);
    reject = true;
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 3 })
          .put({ completed: true })
      ).status
    ).toBe(502);
    expect(expectSuccess(await client.anilist.get()).entries[0]?.completedEpisodes).toEqual([1, 2]);
    reject = false;
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 1 })
          .put({ completed: false })
      ).status
    ).toBe(200);
    expect(mutations).toEqual([2, 0]);
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 4 })
          .put({ completed: true })
      ).status
    ).toBe(400);
    await client.plugins({ id: "anilist" }).put({ apiKey: "", enabled: true });
    expect(
      (
        await client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: 1 })
          .put({ completed: true })
      ).status
    ).toBe(409);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});
