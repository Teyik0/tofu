// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential public API requests.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { DiscoveryResult } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

test("discovery keeps the literal query and makes no catalogue request until Jev is configured and enabled", async () => {
  const context = await fixture(1024, []);
  const queries: string[] = [];
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      queries.push(url.searchParams.get("q") ?? url.pathname);
      return new Response(
        `<rss><channel><item><guid>classic</guid><title>Re:Zero S04E09</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}/anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const query = "re zero ep9 season4";
    const response = await request("/discover", json({ query, sources: ["nyaa"] }));
    const result = (await response.json()) as DiscoveryResult;
    expect(response.status).toBe(200);
    expect(queries).toEqual([query]);
    expect(result.releases.map((release) => release.id)).toEqual(["classic"]);
    expect(result.search).toMatchObject({
      episode: null,
      queries: [query],
      resolved: false,
      season: null,
      title: query,
    });
    queries.length = 0;
    await request("/plugins/jev", {
      ...json({ apiKey: "configured-but-disabled", enabled: false }),
      method: "PUT",
    });
    const disabled = await request("/discover", json({ query, sources: ["nyaa"] }));
    expect(((await disabled.json()) as DiscoveryResult).search?.resolved).toBe(false);
    expect(queries).toEqual([query]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("discovery defaults to active sources and filters the unsearchable Tsundere feed", async () => {
  const context = await fixture(1024, []);
  const calls: string[] = [];
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      calls.push(url.pathname);
      if (url.pathname === "/anilist") {
        return Response.json({ data: { Page: { media: [] } } });
      }
      return Response.json({
        entries: [
          {
            episode: 9,
            id: "wanted",
            season: 1,
            title: "Example S01E09",
            torrentUrl: context.magnet,
          },
          {
            episode: 9,
            id: "unrelated",
            season: 1,
            title: "Another Show S01E09",
            torrentUrl: context.magnet,
          },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: `${base}/anilist`,
      c411: `${base}/c411`,
      jev: base,
      nyaa: `${base}/nyaa`,
      tsundere: `${base}/tsundere`,
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
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    const response = await request("/discover", json({ query: "Example" }));
    expect(response.status).toBe(200);
    const result = (await response.json()) as DiscoveryResult;
    expect(result.releases.map((release) => release.id)).toEqual(["wanted"]);
    expect(calls).toEqual(["/tsundere"]);
    calls.length = 0;
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const selected = await request(
      "/discover",
      json({ query: "Example S01E09", sources: ["tsundere"] })
    );
    expect(
      ((await selected.json()) as DiscoveryResult).releases.map((release) => release.id)
    ).toEqual(["wanted"]);
    expect(calls).toEqual(["/tsundere"]);
    calls.length = 0;
    await request("/plugins/tsundere", { ...json({ enabled: false }), method: "PUT" });
    const disabled = await request(
      "/discover",
      json({ query: "Example s1 ep9", sources: ["tsundere"] })
    );
    expect(((await disabled.json()) as DiscoveryResult).releases).toEqual([]);
    expect(calls).toEqual([]);
    const empty = await request("/discover", json({ query: "Example", sources: [] }));
    expect(((await empty.json()) as DiscoveryResult).releases).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("natural discovery falls back during a catalogue outage and reads episode numbers from release titles", async () => {
  const context = await fixture(1024, []);
  const calls: string[] = [];
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      calls.push(url.pathname);
      if (url.pathname !== "/tsundere") {
        return new Response("offline", { status: 503 });
      }
      return Response.json({
        entries: [
          { id: "wanted", title: "Example S04E09 VOSTFR 1080p", torrentUrl: context.magnet },
          { id: "wrong-episode", title: "Example S04E08", torrentUrl: context.magnet },
          { id: "wrong-season", title: "Example S03E09", torrentUrl: context.magnet },
          { id: "unknown", title: "Example", torrentUrl: context.magnet },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: `${base}/anilist`,
      c411: base,
      jev: base,
      nyaa: `${base}/nyaa`,
      tsundere: `${base}/tsundere`,
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
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    for (const id of ["nyaa", "tsundere"]) {
      await request(`/plugins/${id}`, { ...json({ enabled: true }), method: "PUT" });
    }
    const response = await request(
      "/discover",
      json({ query: "Example s04e09", sources: ["nyaa", "tsundere"] })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as DiscoveryResult;
    expect(result.releases.map((release) => release.id)).toEqual(["wanted"]);
    expect(result.releases[0]?.episode).toBe(9);
    expect(result.releases[0]?.season).toBe(4);
    expect(result.releases[0]?.seeders).toBeNull();
    expect(result.search?.warning).toContain("unavailable");
    expect(result.errors.map((error) => error.sourceId)).toEqual(["nyaa"]);
    expect(calls.sort()).toEqual(["/anilist", "/nyaa", "/nyaa", "/tsundere"]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("natural discovery searches English and Japanese aliases and keeps only the requested episode", async () => {
  const context = await fixture(1024, []);
  const queries: string[] = [];
  let catalogCalls = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/anilist") {
        catalogCalls += 1;
        const body = (await incoming.json()) as { variables: { search: string } };
        expect(body.variables.search).toBe("re zero");
        return Response.json({
          data: {
            Page: {
              media: [
                {
                  id: 1,
                  synonyms: ["Re Zero", "ReZero"],
                  title: {
                    english: "Re:ZERO -Starting Life in Another World-",
                    native: "Re:ゼロから始める異世界生活",
                    romaji: "Re:Zero kara Hajimeru Isekai Seikatsu",
                  },
                },
                {
                  id: 4,
                  synonyms: [],
                  title: {
                    english: "Re:ZERO -Starting Life in Another World- Season 4",
                    native: null,
                    romaji: "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season",
                  },
                },
              ],
            },
          },
        });
      }
      const rows = [
        { id: "short-title", title: "[Group] ReZero S04E09" },
        { id: "english", title: "Re:ZERO -Starting Life in Another World- S04E09" },
        { id: "japanese", title: "Re:Zero kara Hajimeru Isekai Seikatsu S04E09" },
        {
          id: "season-title",
          title: "[Group] Re:Zero kara Hajimeru Isekai Seikatsu 4th Season - 09 [1080p]",
        },
        { id: "wrong-episode", title: "Re:Zero kara Hajimeru Isekai Seikatsu S04E08" },
        { id: "wrong-season", title: "Re:Zero kara Hajimeru Isekai Seikatsu S03E09" },
        { id: "unknown-season", title: "Re:Zero kara Hajimeru Isekai Seikatsu - 09" },
        { id: "unrelated", title: "Unrelated S04E09" },
      ];
      queries.push(url.searchParams.get("q") ?? "");
      return new Response(
        `<rss><channel>${rows.map((row) => `<item><guid>${row.id}</guid><title>${row.title}</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item>`).join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}/anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const response = await request(
      "/discover",
      json({ query: "re zero ep9 season4", sources: ["nyaa"] })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as DiscoveryResult;
    expect(result.releases.map((release) => release.id).sort()).toEqual([
      "english",
      "japanese",
      "season-title",
      "short-title",
    ]);
    expect(queries.some((query) => query.includes("Starting Life in Another World"))).toBe(true);
    expect(queries.some((query) => query.includes("kara Hajimeru Isekai Seikatsu"))).toBe(true);
    expect(queries.some((query) => query.includes("S04E09"))).toBe(true);
    expect(catalogCalls).toBe(1);
    queries.length = 0;
    const titleOnly = await request("/discover", json({ query: "re zero", sources: ["nyaa"] }));
    const allEpisodes = (await titleOnly.json()) as DiscoveryResult;
    expect(allEpisodes.search?.resolved).toBe(true);
    expect(queries.some((query) => query.includes("Starting Life in Another World"))).toBe(true);
    expect(queries.some((query) => query.includes("kara Hajimeru Isekai Seikatsu"))).toBe(true);
    expect(allEpisodes.releases.some((release) => release.id === "unrelated")).toBe(false);
    queries.length = 0;
    const shorthand = await request(
      "/discover",
      json({ query: "re zero s4 ep9", sources: ["nyaa"] })
    );
    expect(
      ((await shorthand.json()) as DiscoveryResult).releases.map((release) => release.id).sort()
    ).toEqual(["english", "japanese", "season-title", "short-title"]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
