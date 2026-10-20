import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { AniListReleases, LibraryState } from "../../src/types";
import { createTestApi } from "../helpers/application";
import { expectSuccess } from "../helpers/problem";
import { openTestServices } from "../helpers/services";
import { fixture, torrentBytes, waitFor } from "../helpers/torrent";

test("catalog anime can find and download episodes without joining a personal list", async () => {
  const context = await fixture(4096, []);
  const upstream = Bun.serve({
    async fetch(incoming) {
      if (new URL(incoming.url).pathname === "/anilist") {
        const body = (await incoming.json()) as { variables: { mediaId: number } };
        expect(body.variables.mediaId).toBe(99);
        return Response.json({
          data: { Media: { episodes: 12, id: 99, title: { romaji: "Catalog Example" } } },
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
  const service = await openTestServices({
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
  const client = treaty(api).api;
  try {
    await service.releaseAutomation.close();
    await client.plugins({ id: "nyaa" }).put({ enabled: true });
    const response = await client.anilist.entries({ mediaId: "99" }).releases.post({});
    expect(response.status).toBe(200);
    const result = expectSuccess(response) as AniListReleases;
    expect(result.errors).toEqual([]);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ episode: 1, id: "catalog-release" });
    const added = await client.discover.add.post({
      destinationId: "default",
      id: "catalog-release",
      paused: false,
      sourceId: "nyaa",
    });
    expect(added.status).toBe(200);
    const dashboard = await waitFor(
      async () => expectSuccess(await client.state.get()) as LibraryState,
      // Received bytes can reach 100% before verification and disk writes finish.
      (snapshot) =>
        snapshot.torrents.some(
          (download) => download.id === context.seed.infoHash && download.status === "seeding"
        )
    );
    const torrent = dashboard.torrents.find((item) => item.id === context.seed.infoHash);
    expect(torrent?.progress).toBe(1);
    const content = await client
      .torrents({ id: context.seed.infoHash })
      .files({ index: "0" })
      .content.get();
    expect(content.status).toBe(200);
    expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
    const state = expectSuccess(await client.anilist.get());
    expect(state.entries).toEqual([]);
    expect(state.subscriptions).toEqual([]);
  } finally {
    await api.application.close();
    upstream.stop(true);
    await context.close();
  }
}, 30_000);
