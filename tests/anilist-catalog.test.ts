import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

test("AniList catalog browses trending anime without an account and keeps personal lists intact", async () => {
  const context = await fixture(1024, []);
  const requests: { query: string; variables: { sort: string[]; page: number } }[] = [];
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = await incoming.json();
      requests.push(body);
      if (body.query.includes("GenreCollection")) {
        return Response.json({
          data: {
            ExternalLinkSourceCollection: [
              { id: 7, isDisabled: null, site: "Crunchyroll", type: "STREAMING" },
              { id: 8, isDisabled: true, site: "Disabled site", type: "STREAMING" },
              { id: 9, isDisabled: false, site: "Official site", type: "INFO" },
            ],
            GenreCollection: ["Drama", "Action"],
            MediaTagCollection: [
              { category: "Setting", isAdult: false, name: "Space" },
              { category: "Other", isAdult: true, name: "Adult tag" },
            ],
          },
        });
      }
      return Response.json({
        data: {
          Page: {
            media: [
              {
                averageScore: null,
                coverImage: { large: "https://example.com/cover.jpg" },
                endDate: { day: null, month: null, year: null },
                genres: ["Action"],
                id: 99,
                nextAiringEpisode: { airingAt: 1_792_000_000, episode: 2 },
                startDate: { day: 3, month: 4, year: 2026 },
                status: "RELEASING",
                studios: { nodes: [{ name: "Example Studio" }] },
                synonyms: ["Alias"],
                title: { english: "Example", romaji: "Trending Example" },
                trending: 321,
              },
            ],
            pageInfo: { currentPage: body.variables.page, hasNextPage: true },
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
  try {
    await api.handle(
      new Request("http://localhost/api/anilist/preferences", {
        ...json({ visibleStatuses: [] }),
        method: "PUT",
      })
    );
    const response = await api.handle(
      new Request("http://localhost/api/anilist/catalog", json({}))
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(requests[0]?.variables).toMatchObject({ page: 1, sort: ["TRENDING_DESC", "ID_DESC"] });
    expect(result).toMatchObject({
      hasNextPage: true,
      media: [
        {
          airingStatus: "RELEASING",
          aliases: ["Trending Example", "Example", "Alias"],
          averageScore: null,
          episodes: null,
          mediaId: 99,
          title: "Trending Example",
          trending: 321,
        },
      ],
      page: 1,
    });
    const state = await (await api.handle(new Request("http://localhost/api/anilist"))).json();
    expect(state.entries).toEqual([]);
    expect(state.visibleStatuses).toEqual([]);
    const filtered = await api.handle(
      new Request(
        "http://localhost/api/anilist/catalog",
        json({
          airingStatus: "RELEASING",
          countryOfOrigin: "JP",
          doujin: "exclude",
          durationMax: 30,
          durationMin: 20,
          episodesMax: 24,
          episodesMin: 12,
          excludedGenres: ["Horror"],
          excludedTags: ["Gore"],
          format: "TV",
          genres: ["Action"],
          page: 2,
          search: "Example",
          season: "SPRING",
          sort: "score",
          source: "MANGA",
          streamingOn: 7,
          tags: ["Space"],
          year: 2026,
          yearMax: 2026,
          yearMin: 2020,
        })
      )
    );
    expect(filtered.status).toBe(200);
    expect(requests[1]?.variables).toMatchObject({
      countryOfOrigin: "JP",
      duration_greater: 19,
      duration_lesser: 31,
      episodes_greater: 11,
      episodes_lesser: 25,
      format: "TV",
      genre_in: ["Action"],
      genre_not_in: ["Horror"],
      licensedById: 7,
      page: 2,
      search: "Example",
      season: "SPRING",
      seasonYear: 2026,
      sort: ["SCORE_DESC", "ID_DESC"],
      source: "MANGA",
      startDate_greater: 20_191_231,
      startDate_lesser: 20_270_101,
      status: "RELEASING",
      tag_in: ["Space"],
      tag_not_in: ["Gore"],
    });
    expect(requests[1]?.variables).not.toHaveProperty("isLicensed");
    const invalid = await api.handle(
      new Request(
        "http://localhost/api/anilist/catalog",
        json({ episodesMax: 12, episodesMin: 24 })
      )
    );
    expect(invalid.status).toBe(400);
    expect(requests).toHaveLength(2);
    expect(result.media[0]).toMatchObject({
      endDate: { day: null, month: null, year: null },
      nextAiringEpisode: { airingAt: 1_792_000_000, episode: 2 },
      releaseDate: { day: 3, month: 4, year: 2026 },
      studios: ["Example Studio"],
    });
    const options = await (
      await api.handle(new Request("http://localhost/api/anilist/catalog/options"))
    ).json();
    expect(options).toEqual({
      genres: ["Action", "Drama"],
      streaming: [{ id: 7, name: "Crunchyroll" }],
      tags: [{ category: "Setting", isAdult: false, name: "Space" }],
    });
    await api.handle(new Request("http://localhost/api/anilist/catalog/options"));
    expect(requests).toHaveLength(3);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});
