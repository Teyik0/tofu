// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfers.
// biome-ignore-all lint/style/noNonNullAssertion: missing fixtures must fail these integration tests immediately.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AutomationDraft, AutomationRule, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

test("failed upgrades keep the old files and a manually removed fallback is never resurrected", async () => {
  const context = await fixture(4096, []);
  let better = false;
  let failures = 0;
  const upstream = Bun.serve({
    fetch(incoming): Response {
      if (new URL(incoming.url).pathname === "/unavailable.torrent") {
        failures += 1;
        return new Response("offline", { status: 503 });
      }
      return Response.json({
        entries: [
          {
            episode: 1,
            id: "old",
            infohash: context.seed.infoHash,
            quality: "720p",
            season: 1,
            title: "Example S01E01 VF 720p",
            torrentUrl: context.magnet,
          },
          ...(better
            ? [
                {
                  episode: 1,
                  id: "better",
                  quality: "1080p",
                  season: 1,
                  title: "Example S01E01 VF 1080p",
                  torrentUrl: `http://127.0.0.1:${upstream.port}/unavailable.torrent`,
                },
              ]
            : []),
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
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
    ).json()) as AutomationDraft;
    const rule = (await (
      await request(
        "/automations",
        json({
          ...draft,
          deleteReplacedFiles: true,
          includeExisting: true,
          resolutions: ["1080p", "720p"],
          sources: ["tsundere"],
        })
      )
    ).json()) as AutomationRule;
    await request(`/automations/${rule.id}/run`, json({}));
    const state = await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    const detail = state.detail!;
    const oldPath = join(detail.savePath, detail.files[0]!.path);
    better = true;
    await request(`/automations/${rule.id}/run`, json({}));
    expect(service.snapshot().decisions[0]?.status).toBe("error");
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(1);
    expect(await Bun.file(oldPath).bytes()).toEqual(new Uint8Array(context.bytes));
    await request(`/automations/${rule.id}/run`, json({}));
    expect(failures).toBe(2);
    await request(`/torrents/${context.seed.infoHash}`, {
      ...json({ deleteFiles: false }),
      method: "DELETE",
    });
    await request(`/automations/${rule.id}/run`, json({}));
    expect(failures).toBe(2);
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(0);
    expect(await Bun.file(oldPath).exists()).toBe(true);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("equal and worse releases are skipped, ideal episodes stop Jev matching while new episodes stay monitored", async () => {
  const context = await fixture(4096, []);
  const next = await fixture(8192, [], "next.bin");
  let clock = Date.now();
  let calls = 0;
  let entries = [
    {
      episode: 1,
      id: "initial",
      infohash: context.seed.infoHash,
      quality: "720p",
      season: 1,
      title: "Example S01E01 VF 720p",
      torrentUrl: context.magnet,
    },
  ];
  const upstream = Bun.serve({
    fetch(incoming) {
      if (new URL(incoming.url).pathname === "/jev") {
        calls += 1;
        return Response.json({
          answers: { identity: { noul: 1, type: "noul" }, requirements: { noul: 1, type: "noul" } },
          model: "test",
          usage: {},
        });
      }
      return Response.json({ entries });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { c411: base, jev: `${base}/jev`, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: () => clock,
  });
  const api = await createTestApi(
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
    ).json()) as AutomationDraft;
    await request("/plugins/jev", { ...json({ apiKey: "test", enabled: true }), method: "PUT" });
    const rule = (await (
      await request(
        "/automations",
        json({
          ...draft,
          includeExisting: true,
          matchMode: "jev",
          resolutions: ["1080p", "720p", "480p"],
          sources: ["tsundere"],
        })
      )
    ).json()) as AutomationRule;
    await request(`/automations/${rule.id}/run`, json({}));
    expect(calls).toBe(1);
    entries = [
      {
        ...entries[0]!,
        id: "equal",
        infohash: next.seed.infoHash,
        title: "Example S01E01 VF 720p alternative",
        torrentUrl: next.magnet,
      },
      {
        ...entries[0]!,
        id: "worse",
        infohash: next.seed.infoHash,
        quality: "480p",
        title: "Example S01E01 VF 480p",
        torrentUrl: next.magnet,
      },
    ];
    clock += 2 * 86_400_000;
    await request(`/automations/${rule.id}/run`, json({}));
    expect(calls).toBe(1);
    expect(context.engine.snapshot(null, false).torrents.map((torrent) => torrent.id)).toEqual([
      context.seed.infoHash,
    ]);
    await request(`/automations/${rule.id}`, {
      ...json({ ...rule, resolutions: ["720p", "480p"] }),
      method: "PUT",
    });
    entries = [
      { ...entries[0]!, quality: "720p", title: "Example S01E01 VF 720p perfect alternative" },
    ];
    await request(`/automations/${rule.id}/run`, json({}));
    expect(calls).toBe(1);
    entries.push({ ...entries[0]!, episode: 2, id: "next", title: "Example S01E02 VF 720p" });
    await request(`/automations/${rule.id}/run`, json({}));
    expect(calls).toBe(2);
    expect(service.snapshot().decisions).toHaveLength(2);
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(2);
  } finally {
    await service.close();
    upstream.stop(true);
    await Promise.all([context.close(), next.close()]);
  }
});

test.each([true, false])(
  "a fallback is upgraded after restart and old file deletion is opt-in (%s)",
  async (deleteReplacedFiles) => {
    const fallback = await fixture(4096, []);
    const replacement = await fixture(8192, [], "1080p.bin");
    let available = false;
    const upstream = Bun.serve({
      fetch: () =>
        Response.json({
          entries: [
            {
              episode: 1,
              id: "fallback",
              infohash: fallback.seed.infoHash,
              quality: "720p",
              season: 1,
              title: "Example S01E01 VF 720p",
              torrentUrl: fallback.magnet,
            },
            ...(available
              ? [
                  {
                    episode: 1,
                    id: "replacement",
                    infohash: replacement.seed.infoHash,
                    quality: "1080p",
                    season: 1,
                    title: "Example S01E01 VF 1080p",
                    torrentUrl: replacement.seed.magnetURI,
                  },
                ]
              : []),
          ],
        }),
      hostname: "127.0.0.1",
      port: 0,
    });
    const base = `http://127.0.0.1:${upstream.port}`;
    const options = {
      dataDir: join(fallback.directory, "feeds"),
      endpoints: { c411: base, jev: base, nyaa: base, tsundere: base },
      engine: () => fallback.engine,
      now: Date.now,
    };
    let service = await AutomationService.open(options);
    let api = await createTestApi(
      () => fallback.engine,
      fallback.sync.options,
      () => service
    );
    const request = (path: string, init: RequestInit | undefined) =>
      api.handle(new Request(`http://localhost/api${path}`, init));
    const run = async (id: string) =>
      (await (await request(`/automations/${id}/run`, json({}))).json()) as AutomationState;
    try {
      await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
      const draft = (await (
        await request(
          "/automations/interpret",
          json({ destinationId: "default", query: "Example" })
        )
      ).json()) as AutomationDraft;
      const rule = (await (
        await request(
          "/automations",
          json({
            ...draft,
            deleteReplacedFiles,
            includeExisting: true,
            resolutions: ["1080p", "720p"],
            sources: ["tsundere"],
          })
        )
      ).json()) as AutomationRule;
      expect((await run(rule.id)).decisions[0]?.status).toBe("added");
      await waitFor(
        async () => fallback.engine.snapshot(fallback.seed.infoHash),
        (state) => state.detail?.status === "seeding"
      );
      const oldDetail = fallback.engine.detail(fallback.seed.infoHash);
      const oldPath = join(oldDetail.savePath, oldDetail.files[0]!.path);
      expect(await Bun.file(oldPath).bytes()).toEqual(new Uint8Array(fallback.bytes));
      await service.close();
      service = await AutomationService.open(options);
      api = await createTestApi(
        () => fallback.engine,
        fallback.sync.options,
        () => service
      );
      available = true;
      const upgraded = await run(rule.id);
      expect(upgraded.decisions[0]?.torrentId).toBe(replacement.seed.infoHash);
      expect(fallback.engine.snapshot(null, false).torrents).toHaveLength(2);
      expect(await Bun.file(oldPath).exists()).toBe(true);
      await service.close();
      service = await AutomationService.open(options);
      api = await createTestApi(
        () => fallback.engine,
        fallback.sync.options,
        () => service
      );
      await request(
        `/torrents/${replacement.seed.infoHash}/peers`,
        json({ peer: `127.0.0.1:${replacement.seeder.torrentPort}` })
      );
      await waitFor(
        async () => fallback.engine.snapshot(replacement.seed.infoHash),
        (state) => state.detail?.status === "seeding"
      );
      await service.tick();
      expect(fallback.engine.snapshot(null, false).torrents.map((torrent) => torrent.id)).toEqual([
        replacement.seed.infoHash,
      ]);
      expect(await Bun.file(oldPath).exists()).toBe(!deleteReplacedFiles);
      const newDetail = fallback.engine.detail(replacement.seed.infoHash);
      expect(await Bun.file(join(newDetail.savePath, newDetail.files[0]!.path)).bytes()).toEqual(
        new Uint8Array(replacement.bytes)
      );
      expect((await run(rule.id)).decisions[0]?.torrentId).toBe(replacement.seed.infoHash);
    } finally {
      await service.close();
      upstream.stop(true);
      await Promise.all([fallback.close(), replacement.close()]);
    }
  }
);
