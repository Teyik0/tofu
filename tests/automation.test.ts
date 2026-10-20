// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfer lifecycle.
import { afterAll, expect, test } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { AutomationState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { expectDefined, expectSuccess } from "./helpers/problem";
import { openTestServices } from "./helpers/services";
import { fixture, network, torrentBytes, waitFor } from "./helpers/torrent";

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
        `<rss><channel>${episodes.map((episode) => `<item><title>Example S01E0${episode} VF 1080p x264</title><link>${context.magnet.replaceAll("&", "&amp;")}</link><guid>episode-${episode}</guid></item>`).join("")}</channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const saved = await client.automations.post({
      ...draft,
      includeExisting: false,
      languages: ["VF"],
      matchMode: "pattern",
      sources: ["nyaa"],
      title: "Example\\s+S01E\\d+",
    });
    expect(saved.status).toBe(200);
    const rule = expectSuccess(saved) as { id: string };
    const before = expectSuccess(
      await client.automations({ id: rule.id }).run.post({})
    ) as AutomationState;
    expect(before.decisions[0]?.status).toBe("ignored");
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(0);
    publishNew = true;
    const after = expectSuccess(
      await client.automations({ id: rule.id }).run.post({})
    ) as AutomationState;
    expect(after.decisions.find((decision) => decision.release.episode === 1)?.status).toBe(
      "ignored"
    );
    expect(after.decisions.find((decision) => decision.release.episode === 2)?.status).toBe(
      "added"
    );
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id: context.seed.infoHash }).get()),
      (detail) => detail.status === "seeding"
    );
    const content = await client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
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
  const service = await openTestServices({
    dataDir,
    endpoints: pluginEndpoints,
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
    const configured = await client
      .plugins({ id: "c411" })
      .put({ apiKey: "test-private-key", enabled: true });
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.error?.value ?? configured.data)).not.toContain(
      "test-private-key"
    ); // Windows protects AppData with account ACLs; chmod cannot express POSIX group permissions.
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
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await client.plugins({ id: "c411" }).put({ apiKey: "c411-secret", enabled: true });
    const search = await client.discover.post({ query: "Example", sources: ["c411"] });
    const catalogue = expectSuccess(search) as import("../src/types").DiscoveryResult;
    expect(JSON.stringify(catalogue)).not.toContain("c411-secret");
    const [release] = catalogue.releases;
    expectDefined(release);
    const added = await client.discover.add.post({
      destinationId: "default",
      id: release.id,
      paused: false,
      sourceId: "c411",
    });
    expect(added.status).toBe(200);
    const result = expectSuccess(added) as { id: string };
    await client
      .torrents({ id: result.id })
      .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` });
    await waitFor(
      async () => expectSuccess(await context.client.state.get({ query: { selected: result.id } })),
      (state) => state.detail?.status === "seeding"
    );
    expect(downloads).toBe(1);
    expect(JSON.stringify((await client.automation.get()).data)).not.toContain("c411-secret");
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
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    const response = await client.discover.post({ query: "Example", sources: ["nyaa"] });
    const result = expectSuccess(response) as import("../src/types").DiscoveryResult;
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
            title: "Example S01E01 VF 720p x264",
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    ) as import("../src/types").AutomationDraft;
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        includeExisting: true,
        languages: ["VF"],
        resolutions: ["1080p", "720p"],
        sources: ["tsundere"],
        waitMinutes: 1,
      })
    ) as { id: string };
    await client.automations({ id: rule.id }).run.post({});
    expect(expectSuccess(await client.automation.get()).decisions[0]?.status).toBe("waiting");
    await client.plugins({ id: "tsundere" }).put({ enabled: false });
    await service.close();
    service = await openTestServices(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    clock += 120_000;
    await service.releaseAutomation.start();
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(0);
    expect(expectSuccess(await client.automation.get()).automations[0]?.status).toBe(
      "source-disabled"
    );
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    await client.automations({ id: rule.id }).run.post({});
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (state) => state.detail?.status === "seeding"
    );
    expect(expectSuccess(await client.automation.get()).decisions[0]?.status).toBe("added");
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test("Jev interprets natural language, sends no tracker credentials and uncertain matches require review", async () => {
  const context = await fixture(4096, []);
  let probability = 0.8;
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
              title: "Japanese alias S01E02 VF 1080p x264",
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
  const service = await openTestServices({
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
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    await client.plugins({ id: "c411" }).put({ apiKey: "tracker-secret", enabled: false });
    await client.plugins({ id: "jev" }).put({ apiKey: "jev-secret", enabled: true });
    const draft = expectSuccess(
      await client.automations.interpret.post({
        destinationId: "default",
        query: "Download Example with VF 1080p",
      })
    ) as import("../src/types").AutomationDraft;
    expect(draft.matchMode).toBe("jev");
    expect(calls).toBe(1);
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        includeExisting: true,
        sources: ["tsundere"],
        title: "Example",
      })
    ) as { id: string };
    await client.automations({ id: rule.id }).run.post({});
    const state = expectSuccess(await client.automation.get()) as AutomationState;
    expect(state.decisions[0]?.status).toBe("review");
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(0);
    await client.automations({ id: rule.id }).run.post({});
    expect(calls).toBe(2); // Same evidence reuses the cached judgement.
    probability = 0.99; // User approval executes only the concrete candidate selected in the review.
    const id = state.decisions[0]?.id;
    await client["automation-decisions"]({ id: id ?? "" }).approve.post({});
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (value) => value.detail?.status === "seeding"
    );
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test("an automation chooses one preferred version, downloads into its thread and catches up at startup", async () => {
  const low = await fixture(4096, [], "Example S01E03.bin");
  const high = await fixture(8192, [], "Example S01E02.bin");
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
            title: `Example S01E0${episode} VF 1080p x264`,
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => engine,
    low.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    const target = join(low.directory, "anime");
    const destination = expectSuccess(
      await client.destinations.post({ downloadPath: target, name: "Anime" })
    ) as { id: string };
    for (const id of ["nyaa", "tsundere"]) {
      await client.plugins({ id }).put({ enabled: true });
    }
    const interpreted = await client.automations.interpret.post({
      destinationId: destination.id,
      query: "Download Example season 1 with VF, prefer 1080p then 720p",
    });
    expect(interpreted.status).toBe(200);
    const draft = expectSuccess(interpreted) as import("../src/types").AutomationDraft;
    expect(draft.languages).toEqual(["VF"]);
    expect(draft.title).toBe("Example");
    expect(draft.season).toBe(1);
    const saved = await client.automations.post({
      ...draft,
      enabled: true,
      includeExisting: true,
      matchMode: "exact",
      sources: ["tsundere", "nyaa"],
      title: "Example",
      waitMinutes: 0,
    });
    expect(saved.status).toBe(200);
    const rule = expectSuccess(saved) as { id: string };
    const run = await client.automations({ id: rule.id }).run.post({});
    expect(run.status).toBe(200);
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: high.seed.infoHash } })),
      (state) => state.detail?.status === "seeding"
    );
    expect(
      expectSuccess(await client.torrents({ id: high.seed.infoHash }).get()).destinationId
    ).toBe(destination.id);
    expect(
      expectSuccess(await client.torrents({ id: high.seed.infoHash }).host.get()).savePath
    ).toBe(target);
    expect(
      Bun.SHA256.hash(await Bun.file(join(target, "Example S01E02.bin")).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(high.bytes, "hex"));
    expect(expectSuccess(await client.state.get()).torrents).toHaveLength(1);
    await client.torrents({ id: high.seed.infoHash }).delete({ deleteFiles: false });
    await client.automations({ id: rule.id }).run.post({});
    expect(expectSuccess(await client.state.get()).torrents).toHaveLength(0); // A genuinely new release appears while the application is closed.
    episode = 3;
    await service.close();
    await engine.close();
    engine = await TorrentEngine.open({
      dataDir: join(low.directory, "state"),
      downloadPath: join(low.directory, "downloads"),
      network,
    });
    service = await openTestServices(options);
    api = await createTestApi(
      () => engine,
      low.sync.options,
      () => service
    );
    client = treaty(api).api;
    clock += 60_000;
    await service.releaseAutomation.start();
    await waitFor(
      async () => expectSuccess(await client.state.get({ query: { selected: low.seed.infoHash } })),
      (state) => state.detail?.status === "seeding"
    );
    expect(expectSuccess(await client.state.get()).torrents).toHaveLength(1);
    expect(
      expectSuccess(await client.torrents({ id: low.seed.infoHash }).get()).destinationId
    ).toBe(destination.id);
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
  const service = await openTestServices({
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
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    for (const id of ["nyaa", "tsundere", "c411"]) {
      await client.plugins({ id }).put({ apiKey: "test-key", enabled: true });
    }
    const response = await client.discover.post({
      query: "Example",
      sources: ["nyaa", "tsundere", "c411"],
    });
    expect(response.status).toBe(200);
    const result = expectSuccess(response) as {
      releases: import("../src/types").FeedRelease[];
      errors: { sourceId: string }[];
    };
    expect(result.releases.length).toBe(2);
    expect(result.releases.find((release) => release.sourceId === "nyaa")?.seeders).toBe(5);
    expect(result.releases.find((release) => release.sourceId === "tsundere")?.seeders).toBeNull();
    expect(result.errors.map((error) => error.sourceId)).toEqual(["c411"]);
    await client.plugins({ id: "nyaa" }).put({ enabled: false });
    const disabled = await client.discover.post({ query: "Example", sources: ["nyaa"] });
    expect((expectSuccess(disabled) as { releases: unknown[] }).releases).toEqual([]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test("plugins are opt-in, preserve their settings and never return API keys", async () => {
  const context = await fixture(1024, []);
  let service: Awaited<ReturnType<typeof openTestServices>> | null = null;
  try {
    const options = {
      dataDir: join(context.directory, "feeds"),
      endpoints: pluginEndpoints,
      engine: () => context.engine,
      now: Date.now,
    };
    service = await openTestServices(options);
    const getService = () => {
      if (!service) {
        throw new Error("service closed");
      }
      return service;
    };
    let api = await createTestApi(() => context.engine, context.sync.options, getService);
    let client = treaty(api).api;
    const initial = await client.automation.get();
    expect(initial.status).toBe(200);
    expect(
      (expectSuccess(initial) as AutomationState).plugins.every((plugin) => !plugin.enabled)
    ).toBe(true);
    const configured = await client
      .plugins({ id: "jev" })
      .put({ apiKey: "private-test-key", enabled: false });
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.error?.value ?? configured.data)).not.toContain(
      "private-test-key"
    );
    await client.plugins({ id: "nyaa" }).put({ enabled: true });
    await service.close();
    service = await openTestServices(options);
    api = await createTestApi(() => context.engine, context.sync.options, getService);
    client = treaty(api).api;
    const state = expectSuccess(await client.automation.get()) as AutomationState;
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
        `<rss><channel><item><title>Example S01E01 VOSTFR 1080p x264</title><guid>cancel-1</guid><enclosure url="http://127.0.0.1:${upstream.port}/torrent"/><nyaa:infoHash>${context.seed.infoHash}</nyaa:infoHash></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const rule = expectSuccess(
      await client.automations.post({ ...draft, includeExisting: true, sources: ["nyaa"] })
    );
    const run = client.automations({ id: rule.id }).run.post({});
    await downloadStarted;
    await client
      .automations({ id: rule.id })
      .put({ ...draft, enabled: false, includeExisting: true, sources: ["nyaa"] });
    finishDownload();
    await run;
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(0);
    const state = expectSuccess(await client.automation.get()) as AutomationState;
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
            title: "[Team] Example S01E01 VOSTFR 1080p x264",
            torrentUrl: context.magnet,
          },
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        includeExisting: true,
        matchMode: "pattern",
        sources: ["tsundere"],
        title: "Example\\s+S01E\\d+",
      })
    );
    const result = expectSuccess(
      await client.automations({ id: rule.id }).run.post({})
    ) as AutomationState;
    expect(result.decisions[0]?.status).toBe("added");
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (state) => state.detail?.status === "seeding"
    );
    const content = await client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(content.status).toBe(200);
    expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
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
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: catalog.url.href, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await client.plugins({ id: "c411" }).put({ apiKey: "private", enabled: true });
    await client.discover.post({ query: "first", sources: ["c411"] });
    await client.discover.post({ query: "second", sources: ["c411"] });
    expect(calls).toHaveLength(2);
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(4000);
    const queued = client.discover.post({ query: "third", sources: ["c411"] });
    await client.plugins({ id: "c411" }).put({ enabled: false });
    await queued;
    expect(calls).toHaveLength(2);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
}, 15_000);
