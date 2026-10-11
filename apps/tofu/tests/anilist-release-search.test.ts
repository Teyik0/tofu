// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential public API requests.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { JevQuestions } from "../src/api/modules/jev/service";
import type { AniListReleases, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

test("anime release search uses language preferences and matches seasonal filenames without mixing cours", async () => {
  const context = await fixture(1024, []);
  const queries: string[] = [];
  let rankings = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/jev") {
        rankings += 1;
        const body = (await incoming.json()) as {
          questions: JevQuestions;
          state: { search: { title: string }; releases: { title: string }[] };
        };
        expect(body.state.releases.every((release) => !release.title.includes("S02E01"))).toBe(
          true
        );
        if (!body.state.search.title.includes("Part 2")) {
          expect(body.state.releases.every((release) => !release.title.includes("S03E13"))).toBe(
            true
          );
        }
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              {
                noul:
                  body.state.releases[Number(id.split("_")[1])]?.title.startsWith("Unrelated") ||
                  body.state.releases[Number(id.split("_")[1])]?.title.includes("Sub Español")
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
  const service = await AutomationService.open({
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
  const request = (path: string, init: RequestInit) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    for (const id of ["anilist", "nyaa"]) {
      await request(`/plugins/${id}`, {
        ...json({ apiKey: id === "anilist" ? "test-anilist" : "", enabled: true }),
        method: "PUT",
      });
    }
    const state = (await (await request("/automation", {})).json()) as AutomationState;
    const preferences = {
      ...state.preferences,
      codecs: ["H.265", "H.264"],
      languages: ["VOSTFR", "MULTI"],
      resolutions: ["1080p", "720p"],
    };
    await request("/automation/preferences", { ...json(preferences), method: "PUT" });
    await request("/anilist/list", json({}));
    const response = await request("/anilist/entries/149118/releases", json({}));
    expect(response.status).toBe(200);
    const found = (await response.json()) as AniListReleases;
    expect([...new Set(found.releases.map((release) => release.episode))]).toEqual([1, 2]);
    expect(
      found.releases.every((release) => release.season === 3 && release.language === "VOSTFR")
    ).toBe(true);
    expect(queries.some((query) => query.includes("VOSTFR"))).toBe(true);
    expect((await (await request("/automation", {})).json()).preferences).toEqual(preferences);
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    const semantic = (await (
      await request("/anilist/entries/149118/releases", json({}))
    ).json()) as AniListReleases;
    expect([...new Set(semantic.releases.map((release) => release.episode))].sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect(rankings).toBe(1);
    const continuation = (await (
      await request("/anilist/entries/179062/releases", json({}))
    ).json()) as AniListReleases;
    expect(continuation.releases).toHaveLength(1);
    expect(continuation.releases[0]).toMatchObject({ episode: 1, sourceEpisode: 13 });
    await request("/plugins/jev", { ...json({ enabled: false }), method: "PUT" });
    const fallback = (await (
      await request("/anilist/entries/179062/releases", json({}))
    ).json()) as AniListReleases;
    expect(fallback.releases[0]).toMatchObject({ episode: 1, sourceEpisode: 13 });
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
