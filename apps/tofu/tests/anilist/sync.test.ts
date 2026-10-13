// biome-ignore-all lint/performance/noAwaitInLoops: verify ordered sync and real transfer lifecycle through public APIs.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { AutomationState } from "../../src/types";
import { createTestApi } from "../helpers/application";
import { expectSuccess } from "../helpers/problem";
import { openTestServices } from "../helpers/services";
import { fixture, torrentBytes, waitFor } from "../helpers/torrent";

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
            title: "Example S01E02 VOSTFR 1080p x264",
            torrentUrl: context.magnet,
          },
          {
            episode: 3,
            id: "new",
            infohash: context.seed.infoHash,
            season: 1,
            title: "Example S01E03 VOSTFR 1080p x264",
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    const enabled = await client
      .plugins({ id: "anilist" })
      .put({ apiKey: "anilist-private-token", enabled: true });
    expect(enabled.status).toBe(200);
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    await client.anilist.list.post({});
    const selected = await client.anilist.selection.put({ enabled: true, mediaIds: [10, 11] });
    expect(selected.status).toBe(200);
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "anime"),
        name: "Anime",
      })
    ) as { id: string };
    const template = expectSuccess(
      await client.automations.interpret.post({
        destinationId: destination.id,
        query: "VOSTFR 1080p",
      })
    );
    const created = await client.anilist.subscriptions.post({
      enabled: true,
      intervalMinutes: 15,
      organization: { mode: "shared" },
      statuses: ["CURRENT", "PLANNING"],
      template: { ...template, includeExisting: true, sources: ["tsundere"] },
    });
    expect(created.status).toBe(200);
    const subscription = expectSuccess(created) as { id: string };
    const synced = await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    expect(synced.status).toBe(200);
    const state = expectSuccess(await client.automation.get()) as AutomationState;
    expect(state.automations).toHaveLength(2);
    expect(state.automations.every((rule) => rule.destinationId === destination.id)).toBe(true);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]?.release.episode).toBe(3);
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (value) => value.detail?.status === "seeding"
    );
    const file = await context.client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(new Uint8Array(torrentBytes(file))).toEqual(context.bytes);
    expect(
      expectSuccess(await context.client.torrents({ id: context.seed.infoHash }).get()).savePath
    ).toBe(join(context.directory, "anime"));
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    expect(
      (expectSuccess(await client.automation.get()) as AutomationState).automations
    ).toHaveLength(2);
    watching = false;
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const removed = expectSuccess(await client.automation.get()) as AutomationState;
    expect(removed.automations.find((rule) => rule.title === "Example")?.enabled).toBe(false);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(1);
    const calls = requests;
    await client.plugins({ id: "anilist" }).put({ enabled: false });
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    expect(requests).toBe(calls);
    expect(JSON.stringify((await client.automation.get()).data)).not.toContain(
      "anilist-private-token"
    );
    await api.application.close();
    service = await openTestServices(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    expect(expectSuccess(await client.anilist.get()).subscriptions).toHaveLength(1);
  } finally {
    await api.application.close();
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
  const service = await openTestServices({
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
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    const configured = await client.anilist.put({
      clientId: "1234",
      clientSecret: "oauth-client-private",
      redirectUri: callback,
      userName: "",
    });
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.error?.value ?? configured.data)).not.toContain(
      "oauth-client-private"
    );
    const started = await client.anilist.connect.post({});
    expect(started.status).toBe(200);
    const authorize = new URL((expectSuccess(started) as { url: string }).url);
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
    const state = expectSuccess(await client.automation.get()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "anilist")?.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain("oauth-access-private");
    const replay = await fetch(
      `${callback}?code=valid-code&state=${authorize.searchParams.get("state")}`
    );
    expect(replay.status).toBe(400);
    expect(exchanges).toBe(1);
  } finally {
    await api.application.close();
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
            title: "Example S01E01 VOSTFR 1080p x264",
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
    await client.plugins({ id: "tsundere" }).put({ enabled: true });
    const template = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "VOSTFR 1080p" })
    );
    const subscription = expectSuccess(
      await client.anilist.subscriptions.post({
        enabled: true,
        intervalMinutes: 15,
        statuses: ["CURRENT"],
        template: { ...template, includeExisting: true, sources: ["tsundere"] },
      })
    ) as { id: string };
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    expect(
      (expectSuccess(await client.automation.get()) as AutomationState).automations
    ).toHaveLength(0);
    const selection = await client.anilist.entries({ mediaId: "10" }).put({ enabled: true });
    expect(selection.status).toBe(200);
    await client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const accepted = expectSuccess(await client.automation.get()) as AutomationState;
    expect(accepted.automations).toHaveLength(1);
    expect(accepted.automations[0]?.title).toBe("Example");
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (state) => state.detail?.status === "seeding"
    );
    await client.anilist.entries({ mediaId: "10" }).put({ enabled: false });
    expect(
      (expectSuccess(await client.automation.get()) as AutomationState).automations[0]?.enabled
    ).toBe(false);
    await api.application.close();
    service = await openTestServices(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    await api.application.anilist.start();
    await service.releaseAutomation.start();
    const restarted = expectSuccess(await client.automation.get()) as AutomationState;
    expect(restarted.automations).toHaveLength(1);
    expect(restarted.automations[0]?.enabled).toBe(false);
    expect(
      expectSuccess(await context.client.state.get({ query: { detail: "false" } })).torrents
    ).toHaveLength(1);
    const content = await context.client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
  } finally {
    await api.application.close();
    upstream.stop(true);
    await context.close();
  }
});
