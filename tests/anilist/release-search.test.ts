// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential public API requests.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { JevQuestions } from "../../src/api/modules/jev/service";
import type { AniListReleases, AutomationState } from "../../src/types";
import { createTestApi } from "../helpers/application";
import { expectSuccess } from "../helpers/problem";
import { openTestServices } from "../helpers/services";
import { fixture } from "../helpers/torrent";

test("anime release search uses language preferences and matches seasonal filenames without mixing cours", async () => {
  const context = await fixture(1024, []);
  const queries: string[] = [];
  let rankings = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/jev") {
        const body = (await incoming.json()) as {
          questions: JevQuestions;
          state:
            | { search: { title: string }; releases: { title: string }[] }
            | { anime: { titles: string[] } };
        };
        if ("anime" in body.state) {
          const part = body.state.anime.titles.some((title) => title.includes("Part 2"))
            ? "2"
            : "unknown";
          return Response.json({
            answers: Object.fromEntries(
              Object.entries(body.questions).map(([id, question]) => {
                let choice = "none";
                if (id === "season") {
                  choice = "3";
                } else if (id === "part") {
                  choice = part;
                } else if (question.type === "choice") {
                  choice =
                    Object.entries(question.criteria).find(([, value]) =>
                      ["Enen no Shouboutai", "Fire Force"].includes(value)
                    )?.[0] ?? "none";
                }
                return [id, { choice, confidence: 0.99, type: "choice" }];
              })
            ),
            model: "test-jev",
          });
        }
        rankings += 1;
        const { releases, search } = body.state;
        expect(releases.every((release) => !release.title.includes("S02E01"))).toBe(true);
        if (!search.title.includes("Part 2")) {
          expect(releases.every((release) => !release.title.includes("S03E13"))).toBe(true);
        }
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              {
                noul:
                  releases[Number(id.split("_")[1])]?.title.startsWith("Unrelated") ||
                  releases[Number(id.split("_")[1])]?.title.includes("Sub Español")
                    ? 0.01
                    : 0.99,
                type: "noul",
              },
            ])
          ),
          model: "test-jev",
        });
      }
      if (url.pathname === "/anilist") {
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
                            episodes: 12,
                            id: 149_118,
                            synonyms: ["Enen no Shouboutai 3rd Season"],
                            title: {
                              english: "Fire Force Season 3",
                              romaji: "Enen no Shouboutai: San no Shou",
                            },
                          },
                          progress: 0,
                          status: "CURRENT",
                        },
                        {
                          media: {
                            episodes: 13,
                            id: 179_062,
                            synonyms: [],
                            title: {
                              english: "Fire Force Season 3 Part 2",
                              romaji: "Enen no Shouboutai: San no Shou Part 2",
                            },
                          },
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
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      const titles = query.includes("VOSTFR")
        ? [
            "Fire Force S03E01 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws",
            "Fire Force S03E02 VOSTFR 720p WEB x264 AAC -Tsundere-Raws",
            "Fire Force S03E13 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (Fire Force Season 3 Part 2)",
            "Fire Force S02E01 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws",
            "Unrelated S03E01 VOSTFR 1080p WEB x264 AAC",
            "[Group] Enen no Shōbōtai: San no Shō - 03 VOSTFR 1080p x264",
            "[Group] Enen no Shōbōtai: San no Shō - 04 [French Subs] [1920x1080 AVC]",
          ]
        : ["[Group] Enen no Shouboutai - San no Shou - 25 [1080p] [Sub Español]"];
      return new Response(
        `<rss><channel>${titles.map((title, index) => `<item><guid>${index}</guid><title>${title}</title><link>https://nyaa.si/download/${index}.torrent</link></item>`).join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: `${base}anilist`,
      c411: base,
      jev: `${base}jev`,
      nyaa: `${base}nyaa`,
      tsundere: base,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    for (const id of ["anilist", "nyaa"]) {
      await client
        .plugins({ id })
        .put({ apiKey: id === "anilist" ? "test-anilist" : "", enabled: true });
    }
    const state = expectSuccess(await client.automation.get()) as AutomationState;
    const preferences: AutomationState["preferences"] = {
      ...state.preferences,
      codecs: ["H.265", "H.264"],
      languages: ["VOSTFR", "MULTI"],
      resolutions: ["1080p", "720p"],
    };
    await client.automation.preferences.put(preferences);
    await client.anilist.list.post({});
    const response = await client.anilist.entries({ mediaId: "149118" }).releases.post({});
    expect(response.status).toBe(200);
    const found = expectSuccess(response) as AniListReleases;
    expect([...new Set(found.releases.map((release) => release.episode))]).toEqual([1, 2]);
    expect(
      found.releases.every((release) => release.season === 3 && release.language === "VOSTFR")
    ).toBe(true);
    expect(queries.some((query) => query.includes("VOSTFR"))).toBe(true);
    expect(expectSuccess(await client.automation.get()).preferences).toEqual(preferences);
    await client.plugins({ id: "jev" }).put({ apiKey: "test-jev", enabled: true });
    const semantic = expectSuccess(
      await client.anilist.entries({ mediaId: "149118" }).releases.post({})
    ) as AniListReleases;
    expect([...new Set(semantic.releases.map((release) => release.episode))].sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect(rankings).toBe(1);
    const continuation = expectSuccess(
      await client.anilist.entries({ mediaId: "179062" }).releases.post({})
    ) as AniListReleases;
    expect(continuation.releases).toHaveLength(1);
    expect(continuation.releases[0]).toMatchObject({ episode: 1, sourceEpisode: 13 });
    await client.plugins({ id: "jev" }).put({ enabled: false });
    const fallback = expectSuccess(
      await client.anilist.entries({ mediaId: "179062" }).releases.post({})
    ) as AniListReleases;
    expect(fallback.releases[0]).toMatchObject({ episode: 1, sourceEpisode: 13 });
  } finally {
    await api.application.close();
    upstream.stop(true);
    await context.close();
  }
});
test("anime searches use short series names and keep the correct season and cour with and without Jev", async () => {
  const context = await fixture(1024, []);
  const title =
    "Maou Gakuin no Futekigousha: Shijou Saikyou no Maou no Shiso, Tensei shite Shison-tachi no Gakkou e Kayou II";
  const english = "The Misfit of Demon King Academy II (Cour 2)";
  const shortTitles = ["Maou Gakuin no Futekigousha", "The Misfit of Demon King Academy"];
  const queries: string[] = [];
  let interpretations = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/anilist") {
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
                            episodes: 12,
                            id: 130_588,
                            synonyms: [],
                            title: {
                              english: "The Misfit of Demon King Academy II",
                              romaji: title,
                            },
                          },
                          progress: 12,
                          status: "COMPLETED",
                        },
                        {
                          media: {
                            episodes: 12,
                            id: 130_590,
                            synonyms: [],
                            title: { english, romaji: `${title} Part 2` },
                          },
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
      if (url.pathname === "/jev") {
        const body = (await incoming.json()) as { questions: JevQuestions };
        if (Object.values(body.questions).some((question) => question.type === "choice")) {
          interpretations += 1;
        }
        return Response.json({
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([id, question]) => {
              if (question.type === "noul") {
                return [id, { noul: 0.99, type: "noul" }];
              }
              const choice =
                id === "season" || id === "part"
                  ? "2"
                  : (Object.entries(question.criteria).find(([, value]) =>
                      id === "title_1"
                        ? value === "The Misfit of Demon King Academy II"
                        : shortTitles.includes(value)
                    )?.[0] ?? "none");
              return [id, { choice, confidence: id === "title_1" ? 0.7 : 0.99, type: "choice" }];
            })
          ),
          model: "test-jev",
        });
      }
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      const matches = shortTitles.some(
        (short) => query.startsWith(`${short} S02`) && query.length < 60
      );
      const releases = matches
        ? [
            "The Misfit of Demon King Academy S02E13 VOSTFR 1080p x264",
            "The Misfit of Demon King Academy S02E24 VOSTFR 720p x264",
            "The Misfit of Demon King Academy S02E01 VOSTFR 1080p x264",
            "The Misfit of Demon King Academy S03E13 VOSTFR 1080p x264",
          ]
        : [];
      return new Response(
        `<rss><channel>${releases.map((name, index) => `<item><guid>${index}</guid><title>${name}</title><link>https://nyaa.si/download/${index}.torrent</link></item>`).join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: `${base}anilist`,
      c411: base,
      jev: `${base}jev`,
      nyaa: base,
      tsundere: base,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    for (const id of ["anilist", "nyaa"]) {
      await client
        .plugins({ id })
        .put({ apiKey: id === "anilist" ? "test-anilist" : "", enabled: true });
    }
    await client.anilist.list.post({});
    const before = expectSuccess(
      await client.anilist.entries({ mediaId: "130590" }).releases.post({})
    ) as AniListReleases;
    expect(
      before.releases
        .map((release) => [release.episode, release.sourceEpisode, release.season])
        .sort()
    ).toEqual([
      [1, 13, 2],
      [12, 24, 2],
    ]);
    expect(before.search?.season).toBe(2);
    expect(queries.every((query) => query.length < 60 && query.includes("S02"))).toBe(true);
    expect(interpretations).toBe(0);
    await client.plugins({ id: "jev" }).put({ apiKey: "test-jev", enabled: true });
    queries.length = 0;
    const response = await client.anilist.entries({ mediaId: "130590" }).releases.post({});
    expect(response.status).toBe(200);
    const found = expectSuccess(response) as AniListReleases;
    expect(
      found.releases
        .map((release) => [release.episode, release.sourceEpisode, release.season])
        .sort()
    ).toEqual([
      [1, 13, 2],
      [12, 24, 2],
    ]);
    expect(found.search?.title).toBe(`${title} Part 2`);
    expect(found.search?.season).toBe(2);
    expect(queries.every((query) => query.length < 60 && query.includes("S02"))).toBe(true);
    expect(interpretations).toBe(1);
    const repeated = expectSuccess(
      await client.anilist.entries({ mediaId: "130590" }).releases.post({})
    ) as AniListReleases;
    expect(repeated.releases).toHaveLength(2);
    expect(interpretations).toBe(1);
    const library = expectSuccess(await client.anilist.get());
    expect(
      library.entries.find((entry: { mediaId: number }) => entry.mediaId === 130_590)?.title
    ).toBe(`${title} Part 2`);
  } finally {
    await api.application.close();
    upstream.stop(true);
    await context.close();
  }
});
test("local anime searches preserve title numbers and meaningful short subtitles without Jev", async () => {
  const context = await fixture(1024, []);
  const queries: string[] = [];
  const titles = ["86", "Lupin III", "Fate/stay night: Unlimited Blade Works"];
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/anilist") {
        const body = (await incoming.json()) as { variables: { mediaId: number } };
        const title = titles[body.variables.mediaId - 1];
        return Response.json({
          data: {
            Media: {
              episodes: 12,
              id: body.variables.mediaId,
              title: { english: title?.toUpperCase(), romaji: title },
            },
          },
        });
      }
      queries.push(url.searchParams.get("q") ?? "");
      return new Response(
        `<rss><channel>${[...titles, "Fate/stay night"].map((title, index) => `<item><guid>${index}</guid><title>${title} - 01 VOSTFR 1080p x264</title><link>https://nyaa.si/download/${index}.torrent</link></item>`).join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "nyaa" }).put({ enabled: true });
    for (const [index, title] of titles.entries()) {
      queries.length = 0;
      const response = await client.anilist.entries({ mediaId: index + 1 }).releases.post({});
      expect(response.status).toBe(200);
      const result = expectSuccess(response) as AniListReleases;
      expect(result.search?.season).toBeNull();
      expect(result.releases.map((release) => release.title)).toEqual([
        `${title} - 01 VOSTFR 1080p x264`,
      ]);
      expect(queries.every((query) => query.toLowerCase().startsWith(title.toLowerCase()))).toBe(
        true
      );
    }
  } finally {
    await api.application.close();
    upstream.stop(true);
    await context.close();
  }
});
