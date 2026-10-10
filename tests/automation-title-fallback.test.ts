// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfers.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AutomationDraft, AutomationState, FeedRelease } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

test("Jev excludes scores below 75 percent from previews and automation decisions", async () => {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/anilist") {
        return Response.json({ data: { Page: { media: [] } } });
      }
      if (url.pathname === "/jev") {
        const body = (await incoming.json()) as { state: { release: { episode: number } } };
        const { episode } = body.state.release;
        const confidence = episode === 3 ? 0.75 : 0.99;
        return Response.json({
          answers: {
            identity: { noul: episode === 1 ? 0.749 : confidence, type: "noul" },
            requirements: { noul: episode === 2 ? 0.749 : 0.99, type: "noul" },
          },
          model: "test-jev",
        });
      }
      return new Response(
        `<rss><channel>${[1, 2, 3, 4].map((episode) => `<item><guid>episode-${episode}</guid><title>Example - 0${episode} VF 1080p</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item>`).join("")}</channel></rss>`
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
      nyaa: base,
      tsundere: base,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const draft = (await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: "Example VF 1080p" })
      )
    ).json()) as AutomationDraft;
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    const input: AutomationDraft = {
      ...draft,
      includeExisting: true,
      matchMode: "jev",
      sources: ["nyaa"],
    };
    const preview = (await (await request("/automations/preview", json(input))).json()) as {
      candidates: { probability: number; release: FeedRelease }[];
      releases: FeedRelease[];
    };
    expect(preview.candidates.map((candidate) => candidate.release.episode).sort()).toEqual([3, 4]);
    expect(preview.releases.map((release) => release.episode).sort()).toEqual([3, 4]);
    const rule = (await (await request("/automations", json(input))).json()) as { id: string };
    const state = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(state.decisions.map((decision) => decision.release.episode).sort()).toEqual([3, 4]);
    expect(state.decisions.find((decision) => decision.release.episode === 3)).toMatchObject({
      probability: 0.75,
      status: "review",
    });
    expect(state.decisions.find((decision) => decision.release.episode === 4)?.status).toBe(
      "added"
    );
    await waitFor(
      async () => context.engine.detail(context.seed.infoHash),
      (detail) => detail.status === "seeding"
    );
    const content = await request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("Jev resolves romaji before English and searches English only when romaji has no acceptable release", async () => {
  const context = await fixture(4096, []);
  const queries: string[] = [];
  let romajiAccepted = true;
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/anilist") {
        return Response.json({
          data: {
            Page: {
              media: [
                {
                  id: 1,
                  synonyms: [],
                  title: { english: "English", native: null, romaji: "Romaji" },
                },
              ],
            },
          },
        });
      }
      if (url.pathname === "/jev") {
        return Response.json({
          answers: {
            identity: { noul: 0.99, type: "noul" },
            requirements: { noul: 0.99, type: "noul" },
          },
          model: "test-jev",
        });
      }
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      const language = query === "Romaji" && !romajiAccepted ? "VF" : "VOSTFR";
      return new Response(
        `<rss><channel><item><guid>${query}-${language}</guid><title>${query} - 01 ${language} 1080p</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item></channel></rss>`
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
      nyaa: base,
      tsundere: base,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const draft = (await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: "English with VOSTFR 1080p" })
      )
    ).json()) as AutomationDraft;
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    const input: AutomationDraft = {
      ...draft,
      includeExisting: true,
      matchMode: "jev",
      sources: ["nyaa"],
    };
    const preview = (await (await request("/automations/preview", json(input))).json()) as {
      candidates: { reason: string | null; release: FeedRelease }[];
    };
    expect(queries).toEqual(["Romaji"]);
    expect(
      preview.candidates.find((candidate) => candidate.reason === null)?.release.workTitle
    ).toBe("Romaji");
    queries.length = 0;
    romajiAccepted = false;
    const rule = (await (await request("/automations", json(input))).json()) as {
      id: string;
      title: string;
    };
    expect(rule.title).toBe("English");
    const state = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(queries).toEqual(["Romaji", "English"]);
    expect(state.decisions[0]).toMatchObject({
      release: { workTitle: "English" },
      status: "added",
    });
    await waitFor(
      async () => context.engine.detail(context.seed.infoHash),
      (detail) => detail.status === "seeding"
    );
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("automation falls back to English after rejected romaji matches in previews, baselines and downloads", async () => {
  const context = await fixture(4096, []);
  const queries: string[] = [];
  let episode = 1;
  const upstream = Bun.serve({
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/jev") {
        const body = (await incoming.json()) as { state: { release: { title: string } } };
        return Response.json({
          answers: {
            identity: {
              noul: body.state.release.title.startsWith("Romaji") ? 0.7 : 0.99,
              type: "noul",
            },
            requirements: { noul: 0.99, type: "noul" },
          },
          model: "test-jev",
        });
      }
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      return new Response(
        `<rss><channel><item><guid>${query}-${episode}</guid><title>${query} - 0${episode} VF 1080p</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: `${base}jev`, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const draft = (await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: "Romaji VF 1080p" })
      )
    ).json()) as AutomationDraft;
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    await request("/plugins/jev", {
      ...json({ apiKey: "test-jev", enabled: true }),
      method: "PUT",
    });
    const input: AutomationDraft = {
      ...draft,
      aliases: ["Romaji", "English"],
      matchMode: "jev",
      sources: ["nyaa"],
      title: "Romaji",
    };
    const preview = (await (await request("/automations/preview", json(input))).json()) as {
      candidates: { release: FeedRelease }[];
    };
    expect(preview.candidates.map((candidate) => candidate.release.workTitle)).toEqual(["English"]);
    expect(queries).toEqual(["Romaji", "English"]);
    queries.length = 0;
    const rule = (await (await request("/automations", json(input))).json()) as { id: string };
    expect(queries).toEqual(["Romaji", "English"]);
    const baseline = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(baseline.decisions[0]).toMatchObject({
      release: { episode: 1, workTitle: "English" },
      status: "ignored",
    });
    episode = 2;
    queries.length = 0;
    const state = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(queries).toEqual(["Romaji", "English"]);
    expect(state.decisions.find((decision) => decision.release.episode === 2)).toMatchObject({
      release: { workTitle: "English" },
      status: "added",
    });
    await waitFor(
      async () => context.engine.detail(context.seed.infoHash),
      (detail) => detail.status === "seeding"
    );
    const content = await request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
