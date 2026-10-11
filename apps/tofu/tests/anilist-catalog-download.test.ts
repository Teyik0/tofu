import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AniListReleases, DashboardState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

test("catalog anime can find and download episodes without joining a personal list", async () => {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    async fetch(incoming) {
      if (new URL(incoming.url).pathname === "/anilist") {
        const body = (await incoming.json()) as { variables: { mediaId: number } };
        expect(body.variables.mediaId).toBe(99);
        return Response.json({
          data: {
            Media: {
              episodes: 12,
              id: 99,
              title: { romaji: "Catalog Example" },
            },
          },
        });
      }
      return new Response(
        `<rss><channel><item><guid>catalog-release</guid><title>Catalog Example - 01 VOSTFR 1080p x264</title><link>${context.magnet.replaceAll("&", "&amp;")}</link></item></channel></rss>`
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = upstream.url.href;
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: `${base}anilist`, c411: base, jev: base, nyaa: base, tsundere: base },
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
    await request("/plugins/nyaa", { ...json({ enabled: true }), method: "PUT" });
    const response = await request("/anilist/entries/99/releases", json({}));
    expect(response.status).toBe(200);
    const result = (await response.json()) as AniListReleases;
    expect(result.errors).toEqual([]);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ episode: 1, id: "catalog-release" });
    const added = await request(
      "/discover/add",
      json({ destinationId: "default", id: "catalog-release", paused: false, sourceId: "nyaa" })
    );
    expect(added.status).toBe(200);
    const dashboard = await waitFor(
      async () => (await (await request("/state", undefined)).json()) as DashboardState,
      (snapshot) =>
        snapshot.torrents.some(
          (download) => download.progress === 1 && download.status === "seeding"
        )
    );
    const torrent = dashboard.torrents.find((item) => item.id === context.seed.infoHash);
    expect(torrent?.progress).toBe(1);
    const content = await request(`/torrents/${context.seed.infoHash}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
    const state = await (await request("/anilist", undefined)).json();
    expect(state.entries).toEqual([]);
    expect(state.subscriptions).toEqual([]);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
}, 30_000);
