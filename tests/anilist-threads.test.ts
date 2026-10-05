// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfers.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../src/server/api";
import { AutomationService } from "../src/server/feeds/service";
import type {
  AniListState,
  AniListSubscription,
  AutomationDraft,
  AutomationState,
  Destination,
} from "../src/types";
import { fixture, json, waitFor } from "./helpers";

async function setup() {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    async fetch(incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/anilist") {
        const body = (await incoming.json()) as { query: string };
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
                          media: { id: 21, synonyms: [], title: { romaji: "One Piece" } },
                          progress: 0,
                          status: "PLANNING",
                        },
                        {
                          media: { id: 10, synonyms: [], title: { romaji: "Example" } },
                          progress: 0,
                          status: "CURRENT",
                        },
                        {
                          media: { id: 22, synonyms: [], title: { romaji: "Unselected" } },
                          progress: 0,
                          status: "PLANNING",
                        },
                      ],
                    },
                  ],
                },
              },
        });
      }
      return new Response(
        `<rss><channel><item><title>One Piece - 01 VOSTFR 1080p</title><guid>21</guid><link>https://nyaa.si/view/21</link><enclosure url="${context.magnet.replaceAll("&", "&amp;")}"/><nyaa:infoHash>${context.seed.infoHash}</nyaa:infoHash></item></channel></rss>`
      );
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
  const api = createApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  await request("/plugins/anilist", { ...json({ apiKey: "token", enabled: true }), method: "PUT" });
  await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
  await request("/anilist/list", json({}));
  await request("/anilist/selection", {
    ...json({ enabled: true, mediaIds: [21, 10] }),
    method: "PUT",
  });
  return {
    ...context,
    async close() {
      await service.close();
      upstream.stop(true);
      await context.close();
    },
    request,
    async restart() {
      await service.close();
      service = await AutomationService.open(options);
    },
  };
}

test("AniList proposes one thread per selected anime under a root without creating folders", async () => {
  const context = await setup();
  try {
    const basePath = join(context.directory, "video");
    const response = await context.request(
      "/anilist/threads/preview",
      json({ basePath, statuses: ["CURRENT", "PLANNING"] })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        destinationId: null,
        downloadPath: join(basePath, "one-piece"),
        mediaId: 21,
        name: "One Piece",
      },
      {
        destinationId: null,
        downloadPath: join(basePath, "example"),
        mediaId: 10,
        name: "Example",
      },
    ]);
    expect(existsSync(basePath)).toBe(false);
    expect((await (await context.request("/state", undefined)).json()).destinations).toHaveLength(
      1
    );
  } finally {
    await context.close();
  }
});

test("AniList creates linked Nyaa rules in per-anime threads with overrides and keeps destinations across sync, pause and restart", async () => {
  const context = await setup();
  try {
    const basePath = join(context.directory, "video");
    const customPath = join(context.directory, "custom-one-piece");
    const existing = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: join(context.directory, "existing"), name: "Existing" })
      )
    ).json()) as Destination;
    const template = (await (
      await context.request(
        "/automations/interpret",
        json({ destinationId: "default", query: "VOSTFR 1080p Nyaa" })
      )
    ).json()) as AutomationDraft;
    const created = await context.request(
      "/anilist/subscriptions",
      json({
        enabled: true,
        intervalMinutes: 15,
        organization: {
          basePath,
          mode: "per-anime",
          overrides: [
            { destinationId: null, downloadPath: customPath, mediaId: 21, name: "OP" },
            {
              destinationId: existing.id,
              downloadPath: existing.downloadPath,
              mediaId: 10,
              name: existing.name,
            },
          ],
        },
        statuses: ["CURRENT", "PLANNING"],
        template: { ...template, includeExisting: true, sources: ["nyaa"] },
      })
    );
    expect(created.status).toBe(200);
    const subscription = (await created.json()) as AniListSubscription;
    const synced = (await (
      await context.request(`/anilist/subscriptions/${subscription.id}/sync`, json({}))
    ).json()) as AniListState;
    expect(synced.subscriptions[0]?.error).toBeNull();
    const state = (await (
      await context.request("/automation", undefined)
    ).json()) as AutomationState;
    const onePiece = state.automations.find((rule) => rule.title === "One Piece");
    expect(onePiece).toBeDefined();
    expect(onePiece?.destinationId).not.toBe("default");
    const { destinations } = (await (await context.request("/state", undefined)).json()) as {
      destinations: Destination[];
    };
    expect(
      destinations.find((destination) => destination.id === onePiece?.destinationId)
    ).toMatchObject({ downloadPath: customPath, name: "OP" });
    expect(state.automations.find((rule) => rule.title === "Example")?.destinationId).toBe(
      existing.id
    );
    expect(
      synced.subscriptions[0]?.bindings.find((binding) => binding.mediaId === 21)?.ruleId
    ).toBe(onePiece?.id);
    await waitFor(
      async () => context.engine.snapshot(context.seed.infoHash),
      (value) => value.detail?.status === "seeding"
    );
    expect(context.engine.detail(context.seed.infoHash).savePath).toBe(customPath);
    await context.request(`/anilist/subscriptions/${subscription.id}`, {
      ...json({ enabled: false }),
      method: "PUT",
    });
    await context.restart();
    await context.request(`/anilist/subscriptions/${subscription.id}`, {
      ...json({ enabled: true }),
      method: "PUT",
    });
    await context.request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const again = (await (
      await context.request("/automation", undefined)
    ).json()) as AutomationState;
    expect(again.automations).toHaveLength(2);
    expect(again.automations.find((rule) => rule.id === onePiece?.id)?.destinationId).toBe(
      onePiece?.destinationId
    );
    expect(
      (
        (await (await context.request("/state", undefined)).json()) as {
          destinations: Destination[];
        }
      ).destinations
    ).toHaveLength(3);
    expect(
      new Uint8Array(
        await (
          await context.request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined)
        ).arrayBuffer()
      )
    ).toEqual(context.bytes);
    await context.request("/anilist/entries/22", { ...json({ enabled: true }), method: "PUT" });
    await context.request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const followed = (await (
      await context.request("/automation", undefined)
    ).json()) as AutomationState;
    const later = followed.automations.find((rule) => rule.title === "Unselected");
    const updated = (await (await context.request("/state", undefined)).json()) as {
      destinations: Destination[];
    };
    expect(
      updated.destinations.find((destination) => destination.id === later?.destinationId)
    ).toMatchObject({ downloadPath: join(basePath, "unselected"), name: "Unselected" });
  } finally {
    await context.close();
  }
});

test("deleting an AniList thread reassigns its rules and subscriptions without recreating it on sync or restart", async () => {
  const context = await setup();
  try {
    const destination = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: join(context.directory, "anime"), name: "Anime" })
      )
    ).json()) as Destination;
    const template = (await (
      await context.request(
        "/automations/interpret",
        json({ destinationId: destination.id, query: "Example Nyaa" })
      )
    ).json()) as AutomationDraft;
    const subscription = (await (
      await context.request(
        "/anilist/subscriptions",
        json({
          enabled: true,
          intervalMinutes: 15,
          organization: {
            basePath: join(context.directory, "video"),
            mode: "per-anime",
            overrides: [
              {
                destinationId: destination.id,
                downloadPath: destination.downloadPath,
                mediaId: 10,
                name: destination.name,
              },
            ],
          },
          statuses: ["CURRENT"],
          template: { ...template, includeExisting: true },
        })
      )
    ).json()) as AniListSubscription;
    await context.request(`/anilist/subscriptions/${subscription.id}/sync`, json({}));
    const response = await context.request(`/destinations/${destination.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    await context.restart();
    const synced = (await (
      await context.request(`/anilist/subscriptions/${subscription.id}/sync`, json({}))
    ).json()) as AniListState;
    expect(synced.subscriptions[0]?.error).toBeNull();
    expect(synced.subscriptions[0]?.template.destinationId).toBe("default");
    const organization = synced.subscriptions[0]?.organization;
    expect(organization?.mode).toBe("per-anime");
    expect(organization?.mode === "per-anime" && organization.overrides[0]?.destinationId).toBe(
      "default"
    );
    const state = (await (
      await context.request("/automation", undefined)
    ).json()) as AutomationState;
    expect(state.automations).toHaveLength(1);
    expect(state.automations[0]?.destinationId).toBe("default");
    expect((await (await context.request("/state", undefined)).json()).destinations).toHaveLength(
      1
    );
  } finally {
    await context.close();
  }
});

test("AniList rejects invalid thread overrides before creating a subscription or folders", async () => {
  const context = await setup();
  try {
    const basePath = join(context.directory, "video");
    const template = (await (
      await context.request(
        "/automations/interpret",
        json({ destinationId: "default", query: "Nyaa VOSTFR" })
      )
    ).json()) as AutomationDraft;
    for (const override of [
      { destinationId: null, downloadPath: "relative", mediaId: 21, name: "One Piece" },
      {
        destinationId: "unknown",
        downloadPath: join(basePath, "one-piece"),
        mediaId: 21,
        name: "One Piece",
      },
    ]) {
      const response = await context.request(
        "/anilist/subscriptions",
        json({
          enabled: true,
          intervalMinutes: 15,
          organization: { basePath, mode: "per-anime", overrides: [override] },
          statuses: ["PLANNING"],
          template,
        })
      );
      expect(response.status).toBe(400);
    }
    expect(
      ((await (await context.request("/anilist", undefined)).json()) as AniListState).subscriptions
    ).toHaveLength(0);
    expect(existsSync(basePath)).toBe(false);
  } finally {
    await context.close();
  }
});
