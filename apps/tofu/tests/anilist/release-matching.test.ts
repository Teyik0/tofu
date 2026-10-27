import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { releaseProvider } from "../helpers/release-provider";

const fixtures = [
  { episode: 1156, id: "one-piece", mediaId: 21, title: "ONE PIECE S31E1156 VOSTFR 1080p x264" },
  { episode: 1216, id: "conan", mediaId: 235, title: "Detective Conan S25E1216 VOSTFR 1080p x264" },
  { episode: 1, id: "death-note", mediaId: 1535, title: "Death Note - 01 VOSTFR 1080p x264" },
  {
    episode: 1,
    id: "frieren",
    mediaId: 154_587,
    title: "Frieren Beyond Journey’s End S01E01 VOSTFR 1080p x264",
  },
  { episode: 1, id: "blue-box", mediaId: 170_942, title: "Blue Box S01E01 VOSTFR 1080p x264" },
  { episode: 1, id: "mha", mediaId: 21_459, title: "My Hero Academia S01E01 VOSTFR 1080p x264" },
  {
    episode: 1,
    id: "aot",
    mediaId: 131_681,
    title: "Shingeki no Kyojin The Final Season Part 2 - 01 VOSTFR 1080p x264",
  },
] as const;

for (const source of ["nyaa", "tsundere", "c411"] as const) {
  test(`${source} preserves airing and finished anime matches, including continuous provider seasons`, async () => {
    await using upstream = releaseProvider();
    upstream.state.entries = [
      ...fixtures,
      { id: "frieren-s2", title: "Frieren Beyond Journey’s End S02E04 VOSTFR 1080p x264" },
      { id: "blue-box-s2", title: "Blue Box S02E04 VOSTFR 1080p x264" },
      { id: "mha-s8", title: "My Hero Academia S08E11 VOSTFR 1080p x264" },
      { id: "bleach-49", title: "Bleach S17E49 VOSTFR 1080p x264" },
      { id: "bleach-50", title: "Bleach S17E50 VOSTFR 1080p x264" },
    ];
    await using app = await application({
      entry: "tests/helpers/providers-server.ts",
      provider: upstream.url,
    });
    const { client } = await app.start();
    success(
      await client
        .plugins({ id: source })
        .put(source === "c411" ? { apiKey: "test-c411-key", enabled: true } : { enabled: true })
    );
    for (const fixture of fixtures) {
      const result = success(
        // biome-ignore lint/performance/noAwaitInLoops: C411 queries share a rate-limited request queue.
        await client.anilist.entries({ mediaId: fixture.mediaId }).releases.post({})
      );
      expect(result.errors).toEqual([]);
      expect(result.releases).toHaveLength(1);
      expect(result.releases[0]).toMatchObject({
        episode: fixture.episode,
        sourceId: source,
        title: fixture.title,
      });
    }
    upstream.state.entries = [
      { id: "second-season", title: "Blue Box S02E01 VOSTFR 1080p x264" },
      { id: "first-season", title: "Blue Box S01E01 VOSTFR 1080p x264" },
      { id: "third-season", title: "Blue Box S03E01 VOSTFR 1080p x264" },
    ];
    if (source === "tsundere") {
      success(await client.plugins({ id: source }).put({ enabled: true }));
    }
    const sequel = success(await client.anilist.entries({ mediaId: 189_123 }).releases.post({}));
    expect(sequel.errors).toEqual([]);
    expect(sequel.releases.map((release) => release.title).sort()).toEqual([
      "Blue Box S02E01 VOSTFR 1080p x264",
      "Blue Box S02E04 VOSTFR 1080p x264",
    ]);
    const bleach = success(await client.anilist.entries({ mediaId: 185_874 }).releases.post({}));
    expect(bleach.errors).toEqual([]);
    expect(
      bleach.releases
        .map((release) => ({ episode: release.episode, sourceEpisode: release.sourceEpisode }))
        .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
    ).toEqual([
      { episode: 9, sourceEpisode: 49 },
      { episode: 10, sourceEpisode: 50 },
    ]);
  }, 150_000);
}

test("Tsundere keeps nullable entries and uses AniList identity without bypassing quality or episode checks", async () => {
  await using upstream = releaseProvider();
  upstream.state.entries = [
    {
      episode: null,
      id: "movie",
      metadata: null,
      season: null,
      title: "The Legend of Hei 2 2025 SUBFRENCH 1080p x264",
    },
    { id: "psyren", metadata: { anilistId: 204_011 }, title: "PSYREN S01E04 SUBFRENCH 1080p x264" },
    {
      id: "blue-box-sequel",
      metadata: { anilistId: 189_123 },
      title: "Blue Box S02E04 VOSTFR 1080p x264",
    },
    {
      id: "mha-sequel",
      metadata: { anilistId: 999 },
      title: "My Hero Academia S08E11 VOSTFR 1080p x264",
    },
    {
      id: "unknown-identity",
      metadata: { anilistId: null },
      title: "Death Note - 01 VOSTFR 1080p x264",
    },
    {
      id: "different-name",
      metadata: { anilistId: 154_587 },
      title: "Provider Display Name - 01 VOSTFR 1080p x264",
    },
    {
      id: "wrong-season",
      metadata: { anilistId: 171_030 },
      title: "Frieren Beyond Journey’s End S02E04 VOSTFR 1080p x264",
    },
    {
      id: "wrong-language",
      metadata: { anilistId: 154_587 },
      title: "Provider Display Name - 02 VF 1080p x264",
    },
    {
      id: "unknown-codec",
      metadata: { anilistId: 154_587 },
      title: "Provider Display Name - 03 VOSTFR 1080p",
    },
    {
      id: "wrong-quality",
      metadata: { anilistId: 154_587 },
      title: "Provider Display Name - 04 VOSTFR 480p x264",
    },
    {
      id: "out-of-range",
      metadata: { anilistId: 154_587 },
      title: "Provider Display Name - 29 VOSTFR 1080p x264",
    },
    {
      episode: 50,
      id: "bleach",
      metadata: { anilistId: 185_874 },
      season: 17,
      title: "Bleach S17E50 SUBFRENCH 1080p x264",
    },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  let server = await app.start();
  success(await server.client.plugins({ id: "tsundere" }).put({ enabled: true }));
  for (const [mediaId, ids] of [
    [204_011, ["psyren"]],
    [1535, ["unknown-identity"]],
    [154_587, ["different-name"]],
    [170_942, []],
    [21_459, []],
    [185_874, ["bleach"]],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Each read checks the same feed and its accumulated cache.
    const result = success(await server.client.anilist.entries({ mediaId }).releases.post({}));
    expect(result.errors).toEqual([]);
    expect(result.releases.map((release) => release.id)).toEqual([...ids]);
  }
  await server.stop();
  upstream.state.entries = [];
  server = await app.start();
  const cached = success(
    await server.client.anilist.entries({ mediaId: 154_587 }).releases.post({})
  );
  expect(cached.releases).toHaveLength(1);
  expect(cached.releases[0]).toMatchObject({ anilistId: 154_587, id: "different-name" });
  const legacy = success(await server.client.anilist.entries({ mediaId: 1535 }).releases.post({}));
  expect(legacy.releases[0]?.id).toBe("unknown-identity");
});

test("Nyaa falls back from RSS to HTML while retaining the local anime identity filter", async () => {
  await using upstream = releaseProvider();
  upstream.state.nyaaRssStatus = 503;
  upstream.state.entries = [fixtures[0], fixtures[2]];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const result = success(await client.anilist.entries({ mediaId: 1535 }).releases.post({}));
  expect(result.errors).toEqual([]);
  expect(result.releases).toHaveLength(1);
  expect(result.releases[0]).toMatchObject({
    episode: 1,
    sourceId: "nyaa",
    title: fixtures[2].title,
  });
  expect(upstream.state.requests.some((request) => request.rss)).toBe(true);
  expect(upstream.state.requests.some((request) => !request.rss)).toBe(true);
});

test("AniList automation rejects contradictory provider IDs in preview and execution and preserves them across restart", async () => {
  await using upstream = releaseProvider();
  const title = "Sousou no Frieren";
  upstream.state.entries = [
    { id: "correct", metadata: { anilistId: 154_587 }, title: `${title} - 01 VOSTFR 1080p x264` },
    {
      id: "different-anime",
      metadata: { anilistId: 171_030 },
      title: `${title} - 02 VOSTFR 1080p x264`,
    },
    {
      episode: null,
      id: "unknown-episode",
      metadata: { anilistId: 154_587 },
      season: null,
      title: `${title} VOSTFR 1080p x264`,
    },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  let server = await app.start();
  success(
    await server.client
      .plugins({ id: "anilist" })
      .put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await server.client.plugins({ id: "tsundere" }).put({ enabled: true }));
  success(await server.client.anilist.list.post({}));
  const draft = success(
    await server.client.automations.interpret.post({
      destinationId: "default",
      query: `Download "${title}"`,
    })
  );
  const rule = success(
    await server.client.anilist.entries({ mediaId: 154_587 }).automation.put({
      ...draft,
      anilistId: 1,
      automatic: false,
      includeExisting: true,
      sources: ["tsundere"],
    })
  );
  expect(rule.anilistId).toBe(154_587);
  const preview = success(await server.client.automations.preview.post(rule));
  expect(preview.releases.map((release) => release.id)).toEqual(["correct"]);
  const run = success(await server.client.automations({ id: rule.id }).run.post());
  expect(run.decisions).toHaveLength(1);
  expect(run.decisions[0]).toMatchObject({
    release: { anilistId: 154_587, id: "correct" },
    status: "review",
  });
  await server.stop();
  server = await app.start();
  const restored = success(await server.client.automation.get());
  expect(restored.automations.find((item) => item.id === rule.id)?.anilistId).toBe(154_587);
  expect(restored.decisions[0]?.release.anilistId).toBe(154_587);
  await server.stop();
  {
    using db = new Database(join(app.directory, "state/tofu.sqlite"));
    db.run("UPDATE automations SET value = json_remove(value, '$.anilistId') WHERE id = ?", [
      rule.id,
    ]);
    db.run("UPDATE decisions SET value = json_remove(value, '$.release.anilistId')");
  }
  server = await app.start();
  const legacy = success(await server.client.automation.get());
  const legacyRule = legacy.automations.find((item) => item.id === rule.id);
  expect(legacyRule?.anilistId).toBe(154_587);
  expect(legacy.decisions[0]?.release.anilistId).toBeUndefined();
  const updated = success(
    await server.client.anilist.entries({ mediaId: 154_587 }).automation.put(rule)
  );
  expect(updated.anilistId).toBe(154_587);
});

test("Tsundere rejects invalid AniList IDs at its HTTP boundary", async () => {
  await using upstream = releaseProvider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  for (const anilistId of [0, -1, 1.5]) {
    upstream.state.entries = [
      { id: "invalid-id", metadata: { anilistId }, title: "PSYREN - 01 VOSTFR 1080p x264" },
    ];
    // biome-ignore lint/performance/noAwaitInLoops: Replace the provider response before each validation request.
    const result = success(await client.discover.post({ query: "PSYREN", sources: ["tsundere"] }));
    expect(result.errors).toEqual([{ message: "Invalid JSON feed", sourceId: "tsundere" }]);
    expect(result.releases).toEqual([]);
  }
});

test("real season packs match the first MHA season without including sequels or spin-offs", async () => {
  await using upstream = releaseProvider();
  const title =
    "My Hero Academia S01 1080p NF WEB-DL MULTi AAC2.0 H 264-VARYG (Boku no Hero Academia, Multi-Audio, Multi-Subs)";
  upstream.state.entries = [
    { id: "season-one", title },
    { id: "season-eight", title: "My Hero Academia S08 MULTi 1080p x264" },
    { id: "multiple-seasons", title: "My Hero Academia S01 + S02 MULTi 1080p x264" },
    { id: "season-range", title: "My Hero Academia Season 1-4 MULTi 1080p x264" },
    { id: "spinoff", title: "My Hero Academia Vigilantes S01E01 MULTi 1080p x264" },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const result = success(await client.anilist.entries({ mediaId: 21_459 }).releases.post({}));
  expect(result.errors).toEqual([]);
  expect(result.releases).toHaveLength(1);
  expect(result.releases[0]).toMatchObject({
    episode: null,
    pack: true,
    season: 1,
    title,
    workTitle: "My Hero Academia",
  });
});

test("Bleach automation uses recorded episode coordinates and excludes episodes from earlier parts", async () => {
  await using upstream = releaseProvider();
  upstream.state.entries = [
    {
      id: "bleach-49",
      metadata: { anilistId: 185_874 },
      title: "Bleach S17E49 SUBFRENCH 1080p x264",
    },
    {
      id: "bleach-50",
      metadata: { anilistId: 185_874 },
      title: "Bleach S17E50 SUBFRENCH 1080p x264",
    },
    { id: "previous-part", title: "Bleach S17E39 SUBFRENCH 1080p x264" },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  success(await client.anilist.list.post({}));
  const draft = success(
    await client.automations.interpret.post({ destinationId: "default", query: "Bleach" })
  );
  const rule = success(
    await client.anilist
      .entries({ mediaId: 185_874 })
      .automation.put({ ...draft, automatic: false, includeExisting: true, sources: ["tsundere"] })
  );
  const preview = success(await client.automations.preview.post(rule));
  expect(preview.releases.map((release) => release.episode).sort()).toEqual([10, 9]);
  const run = success(await client.automations({ id: rule.id }).run.post());
  expect(run.decisions).toHaveLength(2);
  expect(run.decisions.map((decision) => decision.release.sourceEpisode).sort()).toEqual([49, 50]);
  expect(run.decisions.every((decision) => decision.status === "review")).toBe(true);
});

test("unavailable episode mappings produce an explicit error instead of unverified matches", async () => {
  await using upstream = releaseProvider();
  upstream.state.mappingStatus = 503;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const result = await client.anilist.entries({ mediaId: 154_587 }).releases.post({});
  expect(result.status).toBe(502);
  expect(result.error?.value).toMatchObject({ detail: "Episode mapping unavailable" });
  const draft = success(
    await client.automations.interpret.post({ destinationId: "default", query: "Frieren" })
  );
  const preview = await client.automations.preview.post({ ...draft, anilistId: 154_587 });
  expect(preview.status).toBe(502);
  expect(preview.error?.value).toMatchObject({ detail: "Episode mapping unavailable" });
});
