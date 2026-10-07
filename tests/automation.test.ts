// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfer lifecycle.
import { afterAll, expect, test } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { createApi } from "../src/server/api";
import { TorrentEngine } from "../src/server/engine";
import { AutomationService } from "../src/server/feeds/service";
import { pluginEndpoints } from "../src/server/plugins/registry";
import type { AutomationState } from "../src/types";
import { fixture, json, network, waitFor } from "./helpers";

const catalog = Bun.serve({
  fetch: () => Response.json({ data: { Page: { media: [] } } }),
  hostname: "127.0.0.1",
  port: 0,
});
afterAll(() => catalog.stop(true));

test("pattern rules exclude existing releases and still download newly published episodes", async () => {
  const context = await fixture(4096, []);
  let publishNew = false;
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      const published = publishNew ? [1, 2] : [1];
      const episodes = url.searchParams.get("q") === "" ? published : [];
      return new Response(
        `<rss><channel>${episodes
          .map(
            (episode) =>
              `<item><title>Example S01E0${episode} VF 1080p</title><link>${context.magnet.replaceAll("&", "&amp;")}</link><guid>episode-${episode}</guid></item>`
          )
          .join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const draft = await (
      await request("/automations/interpret", json({ destinationId: "default", query: "Example" }))
    ).json();
    const saved = await request(
      "/automations",
      json({
        ...draft,
        includeExisting: false,
        matchMode: "pattern",
        sources: ["nyaa"],
        title: "Example\\s+S01E\\d+",
      })
    );
    expect(saved.status).toBe(200);
    const rule = (await saved.json()) as { id: string };
    const before = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(before.decisions[0]?.status).toBe("ignored");
    expect(context.engine.snapshot(null).torrents).toHaveLength(0);
    publishNew = true;
    const after = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(after.decisions.find((decision) => decision.release.episode === 1)?.status).toBe(
      "ignored"
    );
    expect(after.decisions.find((decision) => decision.release.episode === 2)?.status).toBe(
      "added"
    );
    await waitFor(
      async () => context.engine.detail(context.seed.infoHash),
      (detail) => detail.status === "seeding"
    );
    const content = await request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("plugin credentials stay private when automation reuses an existing data directory", async () => {
  const context = await fixture(1024, []);
  const dataDir = join(context.directory, "state");
  await chmod(dataDir, 0o755);
  const service = await AutomationService.open({
    dataDir,
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  try {
    const configured = await api.handle(
      new Request("http://localhost/api/plugins/c411", {
        ...json({ apiKey: "test-private-key", enabled: true }),
        method: "PUT",
      })
    );
    expect(configured.status).toBe(200);
    expect(await configured.text()).not.toContain("test-private-key");
    // Windows protects AppData with account ACLs; chmod cannot express POSIX group permissions.
    if (process.platform !== "win32") {
      expect((await stat(dataDir)).mode % 0o100).toBe(0);
    }
  } finally {
    await service.close();
    await context.close();
  }
});

test("C411 downloads the enclosure server-side without exposing its API key", async () => {
  const context = await fixture(4096, []);
  let downloads = 0;
  const upstream = Bun.serve({
    fetch(incoming): Response {
      const url = new URL(incoming.url);
      if (url.pathname === "/torrent") {
        expect(url.searchParams.get("apikey")).toBe("c411-secret");
        downloads += 1;
        return new Response(new Uint8Array(context.seed.torrentFile).buffer);
      }
      return new Response(
        `<rss><channel><item><title>Example S01E01 VF 1080p</title><enclosure url="http://127.0.0.1:${upstream.port}/torrent?apikey=c411-secret" length="4096"/><torznab:attr name="infohash" value="${context.seed.infoHash}"/></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/c411", {
      ...json({ apiKey: "c411-secret", enabled: true }),
      method: "PUT",
    });
    const search = await request("/discover", json({ query: "Example", sources: ["c411"] }));
    const catalogue = (await search.json()) as import("../src/types").DiscoveryResult;
    expect(JSON.stringify(catalogue)).not.toContain("c411-secret");
    const added = await request(
      "/discover/add",
      json({
        destinationId: "default",
        id: catalogue.releases[0]?.id,
        paused: false,
        sourceId: "c411",
      })
    );
    expect(added.status).toBe(200);
    const result = (await added.json()) as { id: string };
    await request(
      `/torrents/${result.id}/peers`,
      json({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    await waitFor(
      async () => context.engine.snapshot(result.id),
      (state) => state.detail?.status === "seeding"
    );
    expect(downloads).toBe(1);
    expect(await (await request("/automation", undefined)).text()).not.toContain("c411-secret");
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("Nyaa search falls back to the HTML catalogue when RSS is unavailable", async () => {
  const context = await fixture(1024, []);
  let htmlSearches = 0;
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.searchParams.get("page") === "rss") {
        return new Response("offline", { status: 503 });
      }
      htmlSearches += 1;
      return new Response(
        '<table><tr><td><a href="/view/123" title="Example S01E01 VF 1080p">Example S01E01 VF 1080p</a></td><td><a href="/download/123.torrent">torrent</a></td></tr></table>'
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  try {
    await api.handle(
      new Request("http://localhost/api/plugins/nyaa", {
        ...json({ enabled: true }),
        method: "PUT",
      })
    );
    const response = await api.handle(
      new Request("http://localhost/api/discover", json({ query: "Example", sources: ["nyaa"] }))
    );
    const result = (await response.json()) as import("../src/types").DiscoveryResult;
    expect(result.releases[0]?.title).toBe("Example S01E01 VF 1080p");
    expect(result.releases[0]?.downloadUrl).toBe(`${base}/download/123.torrent`);
    expect(htmlSearches).toBe(1);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("a waiting candidate survives restart and disabling its plugin suspends the download", async () => {
  const context = await fixture(4096, []);
  let clock = Date.now();
  const upstream = Bun.serve({
    fetch: () =>
      Response.json({
        entries: [
          {
            episode: 1,
            id: "fallback",
            infohash: context.seed.infoHash,
            language: "FRENCH",
            quality: "720p",
            season: 1,
            title: "Example S01E01 VF 720p",
            torrentUrl: context.magnet,
          },
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: () => clock,
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
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    const draft = (await (
      await request("/automations/interpret", json({ destinationId: "default", query: "Example" }))
    ).json()) as import("../src/types").AutomationDraft;
    const rule = (await (
      await request(
        "/automations",
        json({
          ...draft,
          includeExisting: true,
          resolutions: ["1080p", "720p"],
          sources: ["tsundere"],
          waitMinutes: 1,
        })
      )
    ).json()) as { id: string };
    await request(`/automations/${rule.id}/run`, json({}));
    expect(service.snapshot().decisions[0]?.status).toBe("waiting");
    await request("/plugins/tsundere", { ...json({ enabled: false }), method: "PUT" });
    await service.close();
    service = await AutomationService.open(options);
    clock += 120_000;
    await service.start();
    expect(context.engine.snapshot(null).torrents).toHaveLength(0);
    expect(service.snapshot().automations[0]?.status).toBe("source-disabled");
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    await request(`/automations/${rule.id}/run`, json({}));
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    expect(service.snapshot().decisions[0]?.status).toBe("added");
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("Jev interprets natural language, sends no tracker credentials and uncertain matches require review", async () => {
  const context = await fixture(4096, []);
  let probability = 0.6;
  let calls = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      if (new URL(incoming.url).pathname !== "/jev") {
        return Response.json({
          entries: [
            {
              episode: 2,
              id: "release",
              infohash: context.seed.infoHash,
              language: "FRENCH",
              quality: "1080p",
              season: 1,
              title: "Japanese alias S01E02 VF 1080p",
              torrentUrl: context.magnet,
            },
          ],
        });
      }
      calls += 1;
      expect(incoming.headers.get("authorization")).toBe("Bearer jev-secret");
      const body = (await incoming.json()) as {
        questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
      };
      expect(JSON.stringify(body)).not.toContain("tracker-secret");
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [
          id,
          question.type === "noul"
            ? { noul: probability, type: "noul" }
            : {
                choice: Object.keys(question.criteria ?? {})[0],
                confidence: 0.99,
                probabilities: {},
                type: "choice",
              },
        ])
      );
      return Response.json({
        answers,
        model: "test-jev",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: catalog.url.href,
      c411: base,
      jev: `${base}/jev`,
      nyaa: base,
      tsundere: `${base}/feed`,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    await request("/plugins/c411", {
      ...json({ apiKey: "tracker-secret", enabled: false }),
      method: "PUT",
    });
    await request("/plugins/jev", {
      ...json({ apiKey: "jev-secret", enabled: true }),
      method: "PUT",
    });
    const draft = (await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: "Download Example with VF 1080p" })
      )
    ).json()) as import("../src/types").AutomationDraft;
    expect(draft.matchMode).toBe("jev");
    expect(calls).toBe(1);
    const rule = (await (
      await request(
        "/automations",
        json({ ...draft, includeExisting: true, sources: ["tsundere"], title: "Example" })
      )
    ).json()) as { id: string };
    await request(`/automations/${rule.id}/run`, json({}));
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.decisions[0]?.status).toBe("review");
    expect(context.engine.snapshot(null).torrents).toHaveLength(0);
    await request(`/automations/${rule.id}/run`, json({}));
    expect(calls).toBe(2); // Same evidence reuses the cached judgement.
    probability = 0.99;
    // User approval executes only the concrete candidate selected in the review.
    const id = state.decisions[0]?.id;
    await request(`/automation-decisions/${encodeURIComponent(id ?? "")}/approve`, json({}));
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (value) => value.detail?.status === "seeding"
    );
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("an automation chooses one preferred version, downloads into its thread and catches up at startup", async () => {
  const low = await fixture(4096, []);
  const high = await fixture(8192, []);
  let episode = 2;
  let clock = Date.now();
  const upstream = Bun.serve({
    fetch(incoming) {
      if (new URL(incoming.url).pathname === "/nyaa") {
        return new Response(
          `<rss><channel><item><title>Example S01E0${episode} VF 720p x264</title><link>${low.magnet.replaceAll("&", "&amp;")}</link><guid>low-${episode}</guid></item></channel></rss>`
        );
      }
      return Response.json({
        entries: [
          {
            episode,
            id: `high-${episode}`,
            infohash: high.seed.infoHash,
            language: "FRENCH",
            quality: "1080p",
            season: 1,
            size: 8192,
            title: `Example S01E0${episode} VF 1080p`,
            torrentUrl: high.magnet,
          },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  let { engine } = low;
  const options = {
    dataDir: join(low.directory, "feeds"),
    endpoints: {
      anilist: catalog.url.href,
      c411: `${base}/c411`,
      jev: `${base}/jev`,
      nyaa: `${base}/nyaa`,
      tsundere: `${base}/tsundere`,
    },
    engine: () => engine,
    now: () => clock,
  };
  let service = await AutomationService.open(options);
  const api = createApi(
    () => engine,
    low.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const target = join(low.directory, "anime");
    const destination = (await (
      await request("/destinations", json({ downloadPath: target, name: "Anime" }))
    ).json()) as { id: string };
    for (const id of ["nyaa", "tsundere"]) {
      await request(`/plugins/${id}`, { ...json({ enabled: true }), method: "PUT" });
    }
    const interpreted = await request(
      "/automations/interpret",
      json({
        destinationId: destination.id,
        query: "Download Example season 1 with VF, prefer 1080p then 720p",
      })
    );
    expect(interpreted.status).toBe(200);
    const draft = (await interpreted.json()) as import("../src/types").AutomationDraft;
    expect(draft.languages).toEqual(["VF"]);
    expect(draft.title).toBe("Example");
    expect(draft.season).toBe(1);
    const saved = await request(
      "/automations",
      json({
        ...draft,
        enabled: true,
        includeExisting: true,
        matchMode: "exact",
        sources: ["tsundere", "nyaa"],
        title: "Example",
        waitMinutes: 0,
      })
    );
    expect(saved.status).toBe(200);
    const rule = (await saved.json()) as { id: string };
    const run = await request(`/automations/${rule.id}/run`, json({}));
    expect(run.status).toBe(200);
    await waitFor(
      async () => engine.snapshot(high.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    expect(engine.detail(high.seed.infoHash).destinationId).toBe(destination.id);
    expect(engine.detail(high.seed.infoHash).savePath).toBe(target);
    expect(Bun.SHA256.hash(await Bun.file(join(target, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(high.bytes, "hex")
    );
    expect(engine.snapshot(null).torrents).toHaveLength(1);
    await request(`/torrents/${high.seed.infoHash}`, {
      ...json({ deleteFiles: false }),
      method: "DELETE",
    });
    await request(`/automations/${rule.id}/run`, json({}));
    expect(engine.snapshot(null).torrents).toHaveLength(0);
    // A genuinely new release appears while the application is closed.
    episode = 3;
    await service.close();
    await engine.close();
    engine = await TorrentEngine.open({
      dataDir: join(low.directory, "state"),
      downloadPath: join(low.directory, "downloads"),
      network,
    });
    service = await AutomationService.open(options);
    clock += 60_000;
    await service.start();
    await waitFor(
      async () => engine.snapshot(low.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    expect(engine.snapshot(null).torrents).toHaveLength(1);
    expect(engine.detail(low.seed.infoHash).destinationId).toBe(destination.id);
  } finally {
    await service.close();
    await engine.close();
    upstream.stop(true);
    await Promise.all([low.close(), high.close()]);
  }
});

test("search reads real RSS/JSON, preserves unknown values and isolates a failing source", async () => {
  const context = await fixture(1024, []);
  const upstream = Bun.serve({
    fetch(incoming) {
      const url = new URL(incoming.url);
      if (url.pathname === "/nyaa") {
        return new Response(
          `<rss><channel><item><title>Example S01E02 VOSTFR 720p x264</title><link>${context.magnet.replaceAll("&", "&amp;")}</link><guid>release-2</guid><nyaa:infoHash>${context.seed.infoHash}</nyaa:infoHash><nyaa:seeders>5</nyaa:seeders><nyaa:size>1 KiB</nyaa:size></item></channel></rss>`
        );
      }
      if (url.pathname === "/tsundere") {
        return Response.json({
          entries: [
            {
              codec: "H.264",
              episode: 2,
              id: "release-1",
              infohash: context.seed.infoHash,
              language: "SUBFRENCH",
              provider: "nyaa.si",
              quality: "1080p",
              season: 1,
              size: 1024,
              title: "Example S01E02 VOSTFR 1080p",
              torrentUrl: context.magnet,
            },
          ],
        });
      }
      return new Response("unavailable", { status: 503 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: catalog.url.href,
      c411: `${base}/c411`,
      jev: `${base}/jev`,
      nyaa: `${base}/nyaa`,
      tsundere: `${base}/tsundere`,
    },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    for (const id of ["nyaa", "tsundere", "c411"]) {
      await request(`/plugins/${id}`, {
        ...json({ apiKey: "test-key", enabled: true }),
        method: "PUT",
      });
    }
    const response = await request(
      "/discover",
      json({ query: "Example", sources: ["nyaa", "tsundere", "c411"] })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      releases: import("../src/types").FeedRelease[];
      errors: { sourceId: string }[];
    };
    expect(result.releases.length).toBe(2);
    expect(result.releases.find((release) => release.sourceId === "nyaa")?.seeders).toBe(5);
    expect(result.releases.find((release) => release.sourceId === "tsundere")?.seeders).toBeNull();
    expect(result.errors.map((error) => error.sourceId)).toEqual(["c411"]);
    await request("/plugins/nyaa", { ...json({ enabled: false }), method: "PUT" });
    const disabled = await request("/discover", json({ query: "Example", sources: ["nyaa"] }));
    expect(((await disabled.json()) as { releases: unknown[] }).releases).toEqual([]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("plugins are opt-in, preserve their settings and never return API keys", async () => {
  const context = await fixture(1024, []);
  let service: AutomationService | null = null;
  try {
    const options = {
      dataDir: join(context.directory, "feeds"),
      endpoints: pluginEndpoints,
      engine: () => context.engine,
      now: Date.now,
    };
    service = await AutomationService.open(options);
    const getService = () => {
      if (!service) {
        throw new Error("service closed");
      }
      return service;
    };
    const api = createApi(() => context.engine, context.sync.options, getService);
    const request = (path: string, init: RequestInit | undefined) =>
      api.handle(new Request(`http://localhost/api${path}`, init));
    const initial = await request("/automation", undefined);
    expect(initial.status).toBe(200);
    expect(
      ((await initial.json()) as AutomationState).plugins.every((plugin) => !plugin.enabled)
    ).toBe(true);
    const configured = await request("/plugins/jev", {
      ...json({ apiKey: "private-test-key", enabled: false }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    expect(await configured.text()).not.toContain("private-test-key");
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    await service.close();
    service = await AutomationService.open(options);
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
    expect(state.plugins.find((plugin) => plugin.id === "jev")?.hasApiKey).toBe(true);
  } finally {
    await service?.close();
    await context.close();
  }
});

test("disabling a rule while its torrent file is loading cancels the automatic addition", async () => {
  const context = await fixture(4096, []);
  let announceDownload: () => void = () => undefined;
  let finishDownload: () => void = () => undefined;
  const downloadStarted = new Promise<void>((resolve) => {
    announceDownload = resolve;
  });
  const downloadGate = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  const upstream = Bun.serve({
    async fetch(incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/torrent") {
        announceDownload();
        await downloadGate;
        return new Response(new Uint8Array(context.seed.torrentFile).buffer);
      }
      return new Response(
        `<rss><channel><item><title>Example S01E01 VF 1080p</title><guid>cancel-1</guid><enclosure url="http://127.0.0.1:${upstream.port}/torrent"/><nyaa:infoHash>${context.seed.infoHash}</nyaa:infoHash></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const draft = await (
      await request("/automations/interpret", json({ destinationId: "default", query: "Example" }))
    ).json();
    const rule = await (
      await request("/automations", json({ ...draft, includeExisting: true, sources: ["nyaa"] }))
    ).json();
    const run = request(`/automations/${rule.id}/run`, json({}));
    await downloadStarted;
    await request(`/automations/${rule.id}`, {
      ...json({ ...draft, enabled: false, includeExisting: true, sources: ["nyaa"] }),
      method: "PUT",
    });
    finishDownload();
    await run;
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(0);
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.automations[0]?.enabled).toBe(false);
    expect(state.decisions.some((decision) => decision.status === "added")).toBe(false);
  } finally {
    finishDownload();
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("without Jev an explicit pattern matches release names and downloads from real peers", async () => {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    fetch: () =>
      Response.json({
        entries: [
          {
            episode: 1,
            id: "pattern-1",
            infohash: context.seed.infoHash,
            season: 1,
            title: "[Team] Example S01E01 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    const draft = await (
      await request("/automations/interpret", json({ destinationId: "default", query: "Example" }))
    ).json();
    const rule = await (
      await request(
        "/automations",
        json({
          ...draft,
          includeExisting: true,
          matchMode: "pattern",
          sources: ["tsundere"],
          title: "Example\\s+S01E\\d+",
        })
      )
    ).json();
    const result = (await (
      await request(`/automations/${rule.id}/run`, json({}))
    ).json()) as AutomationState;
    expect(result.decisions[0]?.status).toBe("added");
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    const content = await request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("C411 paces searches and disabling the plugin cancels queued requests", async () => {
  const context = await fixture(1024, []);
  const calls: number[] = [];
  const upstream = Bun.serve({
    fetch: () => {
      calls.push(Date.now());
      return new Response("<rss><channel/></rss>");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/c411", {
      ...json({ apiKey: "private", enabled: true }),
      method: "PUT",
    });
    await request("/discover", json({ query: "first", sources: ["c411"] }));
    await request("/discover", json({ query: "second", sources: ["c411"] }));
    expect(calls).toHaveLength(2);
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(4000);
    const queued = request("/discover", json({ query: "third", sources: ["c411"] }));
    await request("/plugins/c411", { ...json({ enabled: false }), method: "PUT" });
    await queued;
    expect(calls).toHaveLength(2);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
}, 15_000);
