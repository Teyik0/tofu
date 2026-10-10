// biome-ignore-all lint/performance/noAwaitInLoops: verify ordered sync and real transfer lifecycle through public APIs.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

test("AniList sync follows Watching and Planning in the chosen thread, skips watched episodes and pauses removed entries", async () => {
  const context = await fixture(4096, []);
  let watching = true;
  let requests = 0;
  const upstream = Bun.serve({
    async fetch(incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/anilist") {
        expect(incoming.headers.get("authorization")).toBe("Bearer anilist-private-token");
        const body = (await incoming.json()) as { query: string; variables: { userId?: number } };
        if (body.query.includes("Viewer")) {
          return Response.json({ data: { Viewer: { id: 42, name: "ExampleUser" } } });
        }
        expect(body.variables.userId).toBe(42);
        requests += 1;
        return Response.json({
          data: {
            MediaListCollection: {
              hasNextChunk: false,
              lists: [
                {
                  entries: [
                    {
                      media: {
                        id: 10,
                        siteUrl: "https://anilist.co/anime/10",
                        synonyms: [],
                        title: { english: "Example", romaji: "Example" },
                      },
                      progress: 2,
                      status: watching ? "CURRENT" : "COMPLETED",
                    },
                    {
                      media: {
                        id: 11,
                        siteUrl: "https://anilist.co/anime/11",
                        synonyms: [],
                        title: { romaji: "Future Show" },
                      },
                      progress: 0,
                      status: "PLANNING",
                    },
                    {
                      media: { id: 12, synonyms: [], title: { romaji: "Finished Show" } },
                      progress: 12,
                      status: "COMPLETED",
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      return Response.json({
        entries: [
          {
            episode: 2,
            id: "seen",
            infohash: "1".repeat(40),
            season: 1,
            title: "Example S01E02 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
          {
            episode: 3,
            id: "new",
            infohash: context.seed.infoHash,
            season: 1,
            title: "Example S01E03 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}/anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const enabled = await request("/plugins/anilist", {
      ...json({ apiKey: "anilist-private-token", enabled: true }),
      method: "PUT",
    });
    expect(enabled.status).toBe(200);
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    await request("/anilist/list", json({}));
    const selected = await request("/anilist/selection", {
      ...json({ enabled: true, mediaIds: [10, 11] }),
      method: "PUT",
    });
    expect(selected.status).toBe(200);
    const destination = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: join(context.directory, "anime"), name: "Anime" })
      )
    ).json()) as { id: string };
    const template = await (
      await request(
        "/automations/interpret",
        json({ destinationId: destination.id, query: "VOSTFR 1080p" })
      )
    ).json();
    const created = await request(
      "/anilist/subscriptions",
      json({
        enabled: true,
        intervalMinutes: 15,
        organization: { mode: "shared" },
        statuses: ["CURRENT", "PLANNING"],
        template: { ...template, includeExisting: true, sources: ["tsundere"] },
      })
    );
    expect(created.status).toBe(200);
    const subscription = (await created.json()) as { id: string };
    const synced = await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    expect(synced.status).toBe(200);
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.automations).toHaveLength(2);
    expect(state.automations.every((rule) => rule.destinationId === destination.id)).toBe(true);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]?.release.episode).toBe(3);
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (value) => value.detail?.status === "seeding"
    );
    const file = await context.request(
      `/torrents/${context.seed.infoHash}/files/0/content`,
      undefined
    );
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(context.bytes);
    expect(context.engine.detail(context.seed.infoHash).savePath).toBe(
      join(context.directory, "anime")
    );
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    expect(
      ((await (await request("/automation", undefined)).json()) as AutomationState).automations
    ).toHaveLength(2);
    watching = false;
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const removed = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(removed.automations.find((rule) => rule.title === "Example")?.enabled).toBe(false);
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(1);
    const calls = requests;
    await request("/plugins/anilist", { ...json({ enabled: false }), method: "PUT" });
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    expect(requests).toBe(calls);
    expect(await (await request("/automation", undefined)).text()).not.toContain(
      "anilist-private-token"
    );
    await service.close();
    service = await AutomationService.open(options);
    expect((await (await request("/anilist", undefined)).json()).subscriptions).toHaveLength(1);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("AniList OAuth validates state and stores the exchanged token without returning either secret", async () => {
  const context = await fixture(1024, []);
  let exchanges = 0;
  const provider = Bun.serve({
    async fetch(incoming): Promise<Response> {
      const input = (await incoming.json()) as {
        client_secret: string;
        code: string;
        grant_type: string;
      };
      expect(input.client_secret).toBe("oauth-client-private");
      expect(input.code).toBe("valid-code");
      expect(input.grant_type).toBe("authorization_code");
      exchanges += 1;
      return Response.json({ access_token: "oauth-access-private", expires_in: 86_400 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const reserved = Bun.serve({
    fetch: () => new Response("reserved"),
    hostname: "127.0.0.1",
    port: 0,
  });
  const callback = `http://127.0.0.1:${reserved.port}/callback`;
  reserved.stop(true);
  const base = `http://127.0.0.1:${provider.port}`;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: {
      anilist: base,
      anilistToken: base,
      c411: base,
      jev: base,
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
    const configured = await request("/anilist", {
      ...json({
        clientId: "1234",
        clientSecret: "oauth-client-private",
        redirectUri: callback,
        userName: "",
      }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    expect(await configured.text()).not.toContain("oauth-client-private");
    const started = await request("/anilist/connect", json({}));
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { url: string }).url);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("redirect_uri")).toBe(callback);
    expect(authorize.searchParams.get("state")).toBeTruthy();
    const rejected = await fetch(`${callback}?code=valid-code&state=wrong`);
    expect(rejected.status).toBe(400);
    expect(exchanges).toBe(0);
    const accepted = await fetch(
      `${callback}?code=valid-code&state=${authorize.searchParams.get("state")}`
    );
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(exchanges).toBe(1);
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "anilist")?.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain("oauth-access-private");
    const replay = await fetch(
      `${callback}?code=valid-code&state=${authorize.searchParams.get("state")}`
    );
    expect(replay.status).toBe(400);
    expect(exchanges).toBe(1);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});

test("AniList titles require validation and unsetting a title persists across sync and restart without deleting downloads", async () => {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    async fetch(incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/anilist") {
        const body = (await incoming.json()) as { query: string };
        expect(body.query).not.toContain("mutation");
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
                          media: { id: 10, synonyms: [], title: { romaji: "Example" } },
                          progress: 0,
                          status: "CURRENT",
                        },
                        {
                          media: { id: 21, synonyms: [], title: { romaji: "One Piece" } },
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
      return Response.json({
        entries: [
          {
            episode: 1,
            id: "selected",
            infohash: context.seed.infoHash,
            season: 1,
            title: "Example S01E01 VOSTFR 1080p",
            torrentUrl: context.magnet,
          },
        ],
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}/anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    await request("/plugins/tsundere", { ...json({ enabled: true }), method: "PUT" });
    const template = await (
      await request(
        "/automations/interpret",
        json({ destinationId: "default", query: "VOSTFR 1080p" })
      )
    ).json();
    const subscription = (await (
      await request(
        "/anilist/subscriptions",
        json({
          enabled: true,
          intervalMinutes: 15,
          statuses: ["CURRENT"],
          template: { ...template, includeExisting: true, sources: ["tsundere"] },
        })
      )
    ).json()) as { id: string };
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    expect(
      ((await (await request("/automation", undefined)).json()) as AutomationState).automations
    ).toHaveLength(0);
    const selection = await request("/anilist/entries/10", {
      ...json({ enabled: true }),
      method: "PUT",
    });
    expect(selection.status).toBe(200);
    await request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const accepted = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(accepted.automations).toHaveLength(1);
    expect(accepted.automations[0]?.title).toBe("Example");
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (state) => state.detail?.status === "seeding"
    );
    await request("/anilist/entries/10", { ...json({ enabled: false }), method: "PUT" });
    expect(
      ((await (await request("/automation", undefined)).json()) as AutomationState).automations[0]
        ?.enabled
    ).toBe(false);
    await service.close();
    service = await AutomationService.open(options);
    await service.start();
    const restarted = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(restarted.automations).toHaveLength(1);
    expect(restarted.automations[0]?.enabled).toBe(false);
    expect(context.engine.snapshot(null, false).torrents).toHaveLength(1);
    const content = await context.request(
      `/torrents/${context.seed.infoHash}/files/0/content`,
      undefined
    );
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
