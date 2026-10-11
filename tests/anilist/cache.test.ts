import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { AutomationService } from "../../src/api/modules/automation/service";
import type { AniListState } from "../../src/types";
import { createTestApi } from "../helpers/application";
import { expectSuccess } from "../helpers/problem";
import { fixture, waitFor } from "../helpers/torrent";

function collection(title: string) {
  return {
    data: {
      MediaListCollection: {
        hasNextChunk: false,
        lists: [
          {
            entries: [
              {
                media: { id: 10, synonyms: [], title: { romaji: title } },
                progress: 0,
                status: "CURRENT",
              },
            ],
          },
        ],
      },
    },
  };
}
test("AniList restores its cached list after restart without contacting upstream", async () => {
  const context = await fixture(4096, []);
  let requests = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection("Cached anime")
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: endpoint,
      c411: endpoint,
      jev: endpoint,
      nyaa: endpoint,
      tsundere: endpoint,
    },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "private-token", enabled: true });
    const loaded = await client.anilist.list.post({});
    expect(loaded.status).toBe(200);
    expect(requests).toBe(2);
    await service.close();
    service = await AutomationService.open(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    const restored = await client.anilist.get();
    const state = expectSuccess(restored) as AniListState;
    expect(state.entries[0]?.title).toBe("Cached anime");
    expect(state.connectedUser).toBe("ExampleUser");
    expect(requests).toBe(2);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test("AniList serves fresh cache and shares concurrent refreshes", async () => {
  const context = await fixture(4096, []);
  let requests = 0;
  let now = 1_000_000;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      await Bun.sleep(30);
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection(`Anime ${now}`)
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: endpoint,
      c411: endpoint,
      jev: endpoint,
      nyaa: endpoint,
      tsundere: endpoint,
    },
    engine: () => context.engine,
    now: () => now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    const concurrent = await Promise.all([
      client.anilist.list.post({}),
      client.anilist.list.post({}),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    expect(requests).toBe(2);
    const fresh = await client.anilist.refresh.post({});
    expect(fresh.status).toBe(200);
    expect(requests).toBe(2);
    now += 5 * 60_000 + 1;
    const refreshed = await Promise.all([
      client.anilist.refresh.post({}),
      client.anilist.refresh.post({}),
    ]);
    expect(requests).toBe(4);
    const [first] = refreshed;
    if (!first) {
      throw new Error("The refresh response is missing");
    }
    expect(expectSuccess(first).entries[0]?.title).toBe(`Anime ${now}`);
    await client.anilist.list.post({});
    expect(requests).toBe(6);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test.each([true, false])(
  "AniList preserves completed=%s episode progress across a restart without refreshing",
  async (completed) => {
    const context = await fixture(1024, []);
    let requests = 0;
    const upstream = Bun.serve({
      async fetch(incoming) {
        requests += 1;
        const body = (await incoming.json()) as { query: string; variables: { progress: number } };
        if (body.query.includes("Viewer")) {
          return Response.json({ data: { Viewer: { id: 42, name: "ExampleUser" } } });
        }
        if (body.query.includes("SaveProgress")) {
          return Response.json({
            data: { SaveMediaListEntry: { progress: body.variables.progress } },
          });
        }
        return Response.json({
          data: {
            MediaListCollection: {
              hasNextChunk: false,
              lists: [
                {
                  entries: [
                    {
                      media: { id: 10, title: { romaji: "Cached anime" } },
                      progress: completed ? 0 : 1,
                      status: "CURRENT",
                    },
                  ],
                },
              ],
            },
          },
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = upstream.url.origin;
    const options = {
      dataDir: join(context.directory, "feeds"),
      endpoints: {
        anilist: endpoint,
        c411: endpoint,
        jev: endpoint,
        nyaa: endpoint,
        tsundere: endpoint,
      },
      engine: () => context.engine,
      now: Date.now,
    };
    let service = await AutomationService.open(options);
    let api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    let client = treaty(api).api;
    try {
      await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
      expect((await client.anilist.list.post({})).status).toBe(200);
      const updated = await client.anilist
        .entries({ mediaId: "10" })
        .episodes({ episode: "1" })
        .put({ completed });
      expect(updated.status).toBe(200);
      expect((expectSuccess(updated) as AniListState).entries[0]).toMatchObject({
        completedEpisodes: completed ? [1] : [],
        progress: completed ? 1 : 0,
      });
      expect(requests).toBe(4);
      await service.close();
      service = await AutomationService.open(options);
      api = await createTestApi(
        () => context.engine,
        context.sync.options,
        () => service
      );
      client = treaty(api).api;
      const restored = await client.anilist.get();
      expect((expectSuccess(restored) as AniListState).entries[0]).toMatchObject({
        completedEpisodes: completed ? [1] : [],
        progress: completed ? 1 : 0,
      });
      expect(requests).toBe(4);
    } finally {
      await service.close();
      upstream.stop(true);
      await context.close();
    }
  }
);
test("AniList returns stale entries immediately, refreshes after the response and keeps them offline", async () => {
  const context = await fixture(4096, []);
  let now = 1_000_000;
  let offline = false;
  let requests = 0;
  let release!: () => void;
  let gate: Promise<void> | null = null;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      if (gate) {
        await gate;
      }
      if (offline) {
        return new Response("Unavailable", { status: 503 });
      }
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection(`Anime ${now}`)
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: endpoint,
      c411: endpoint,
      jev: endpoint,
      nyaa: endpoint,
      tsundere: endpoint,
    },
    engine: () => context.engine,
    now: () => now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    await client.anilist.list.post({});
    now += 5 * 60_000 + 1;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cached = await client.anilist.get();
    expect(expectSuccess(cached).entries[0]?.title).toBe("Anime 1000000");
    await waitFor(
      async () => requests,
      (requestCount) => requestCount >= 3
    );
    expect(requests).toBe(3);
    const pending = client.anilist.refresh.post({});
    release();
    await pending;
    expect(expectSuccess(await client.anilist.get()).entries[0]?.title).toBe(`Anime ${now}`);
    now += 5 * 60_000 + 1;
    offline = true;
    const failed = await client.anilist.list.post({});
    expect(failed.status).toBe(502);
    const state = expectSuccess(await client.anilist.get()) as AniListState;
    expect(state.entries[0]?.title).toBe("Anime 1300001");
    expect(state.refreshError).toContain("503");
    expect(state.refreshing).toBe(false);
    const count = requests;
    await client.anilist.refresh.post({});
    expect(requests).toBe(count);
    await client.plugins({ id: "anilist" }).put({ apiKey: "another-account", enabled: true });
    const switched = await client.anilist.get();
    expect(expectSuccess(switched).entries).toEqual([]);
  } finally {
    release?.();
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
