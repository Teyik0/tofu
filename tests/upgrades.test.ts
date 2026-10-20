// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfers.
// biome-ignore-all lint/style/noNonNullAssertion: missing fixtures must fail these integration tests immediately.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { AutomationDraft, AutomationRule, AutomationState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { expectDefined, expectSuccess } from "./helpers/problem";
import { openTestServices } from "./helpers/services";
import { fixture, waitFor } from "./helpers/torrent";

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
  const service = await openTestServices({
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
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    ) as AutomationDraft;
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        codecs: [],
        deleteReplacedFiles: true,
        includeExisting: true,
        languages: ["VF"],
        resolutions: ["1080p", "720p"],
        sources: ["tsundere"],
      })
    ) as AutomationRule;
    await client.automations({ id: rule.id }).run.post({});
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    const detail = expectSuccess(
      await context.client.torrents({ id: context.seed.infoHash }).host.get()
    );
    const [oldFile] = detail.files;
    expectDefined(oldFile);
    const oldPath = join(detail.savePath, oldFile.path);
    better = true;
    await client.automations({ id: rule.id }).run.post({});
    expect(expectSuccess(await client.automation.get()).decisions[0]?.status).toBe("error");
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(1);
    expect(await Bun.file(oldPath).bytes()).toEqual(new Uint8Array(context.bytes));
    await client.automations({ id: rule.id }).run.post({});
    expect(failures).toBe(2);
    await client.torrents({ id: context.seed.infoHash }).delete({ deleteFiles: false });
    await client.automations({ id: rule.id }).run.post({});
    expect(failures).toBe(2);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(0);
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
  const service = await openTestServices({
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
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    ) as AutomationDraft;
    await client.plugins({ id: "jev" }).put({ apiKey: "test", enabled: true });
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        codecs: [],
        includeExisting: true,
        languages: ["VF"],
        matchMode: "jev",
        resolutions: ["1080p", "720p", "480p"],
        sources: ["tsundere"],
      })
    ) as AutomationRule;
    await client.automations({ id: rule.id }).run.post({});
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
    await client.automations({ id: rule.id }).run.post({});
    expect(calls).toBe(1);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents.map(
        (torrent) => torrent.id
      )
    ).toEqual([context.seed.infoHash]);
    await client.automations({ id: rule.id }).put({ ...rule, resolutions: ["720p", "480p"] });
    entries = [
      { ...entries[0]!, quality: "720p", title: "Example S01E01 VF 720p perfect alternative" },
    ];
    await client.automations({ id: rule.id }).run.post({});
    expect(calls).toBe(1);
    entries.push({ ...entries[0]!, episode: 2, id: "next", title: "Example S01E02 VF 720p" });
    await client.automations({ id: rule.id }).run.post({});
    expect(calls).toBe(2);
    expect(expectSuccess(await client.automation.get()).decisions).toHaveLength(2);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(2);
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
    let service = await openTestServices(options);
    let api = await createTestApi(
      () => fallback.engine,
      fallback.sync.options,
      () => service
    );
    let client = treaty(api).api;
    const run = async (id: string) =>
      expectSuccess(await client.automations({ id }).run.post({})) as AutomationState;
    try {
      await client.plugins({ id: "tsundere" }).put({ enabled: true });
      const draft = expectSuccess(
        await client.automations.interpret.post({ destinationId: "default", query: "Example" })
      ) as AutomationDraft;
      const rule = expectSuccess(
        await client.automations.post({
          ...draft,
          codecs: [],
          deleteReplacedFiles,
          includeExisting: true,
          languages: ["VF"],
          resolutions: ["1080p", "720p"],
          sources: ["tsundere"],
        })
      ) as AutomationRule;
      expect((await run(rule.id)).decisions[0]?.status).toBe("added");
      await waitFor(
        async () =>
          expectSuccess(
            await fallback.client.state.get({ query: { selected: fallback.seed.infoHash } })
          ),
        (state) => state.detail?.status === "seeding"
      );
      const oldDetail = expectSuccess(
        await fallback.client.torrents({ id: fallback.seed.infoHash }).host.get()
      );
      const [oldFile] = oldDetail.files;
      expectDefined(oldFile);
      const oldPath = join(oldDetail.savePath, oldFile.path);
      expect(await Bun.file(oldPath).bytes()).toEqual(new Uint8Array(fallback.bytes));
      await service.close();
      service = await openTestServices(options);
      api = await createTestApi(
        () => fallback.engine,
        fallback.sync.options,
        () => service
      );
      client = treaty(api).api;
      available = true;
      const upgraded = await run(rule.id);
      expect(upgraded.decisions[0]?.torrentId).toBe(replacement.seed.infoHash);
      expect(
        expectSuccess(await fallback.client.state.get({ query: { detail: "false" } })).torrents
      ).toHaveLength(2);
      expect(await Bun.file(oldPath).exists()).toBe(true);
      await service.close();
      service = await openTestServices(options);
      api = await createTestApi(
        () => fallback.engine,
        fallback.sync.options,
        () => service
      );
      client = treaty(api).api;
      await client
        .torrents({ id: replacement.seed.infoHash })
        .peers.post({ peer: `127.0.0.1:${replacement.seeder.torrentPort}` });
      await waitFor(
        async () =>
          expectSuccess(
            await fallback.client.state.get({ query: { selected: replacement.seed.infoHash } })
          ),
        (state) => state.detail?.status === "seeding"
      );
      await service.releaseAutomation.tick();
      expect(
        expectSuccess(await fallback.client.state.get({ query: { detail: "false" } })).torrents.map(
          (torrent) => torrent.id
        )
      ).toEqual([replacement.seed.infoHash]);
      expect(await Bun.file(oldPath).exists()).toBe(!deleteReplacedFiles);
      const newDetail = expectSuccess(
        await fallback.client.torrents({ id: replacement.seed.infoHash }).host.get()
      );
      const [newFile] = newDetail.files;
      expectDefined(newFile);
      expect(await Bun.file(join(newDetail.savePath, newFile.path)).bytes()).toEqual(
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
