import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { pluginEndpoints } from "../../src/api/modules/plugins/service";
import type { FeedRelease } from "../../src/types";
import { createTestApi } from "./application";
import { openTestServices } from "./services";
import { fixture } from "./torrent";

export async function pluginIntegrationFixture() {
  const context = await fixture(4096, []);
  const control = {
    downloads: 0,
    evaluationStarted: Promise.withResolvers<void>(),
    evaluations: 0,
    holdSearch: false as boolean,
    releaseEvaluation: Promise.withResolvers<void>(),
    releaseSearch: Promise.withResolvers<void>(),
    searches: 0,
    searchStarted: Promise.withResolvers<void>(),
  };
  const upstream = Bun.serve({
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/jev") {
        control.evaluations += 1;
        control.evaluationStarted.resolve();
        await control.releaseEvaluation.promise;
        return Response.json({});
      }
      if (url.pathname === "/torrent") {
        control.downloads += 1;
        return new Response(new Uint8Array(context.seed.torrentFile).buffer);
      }
      control.searches += 1;
      if (control.holdSearch) {
        control.searchStarted.resolve();
        await control.releaseSearch.promise;
      }
      return Response.json([
        {
          codec: "H.264",
          downloadUrl: `${upstream.url}torrent?token=source-secret`,
          episode: 1,
          id: "release-1",
          infoHash: context.seed.infoHash,
          language: "VF",
          pack: false,
          pageUrl: `${upstream.url}torrent?token=source-secret`,
          publishedAt: null,
          resolution: "1080p",
          season: 1,
          seeders: 1,
          size: 4096,
          sourceId: "test.releases",
          title: "Example S01E01 VF 1080p x264",
          workTitle: "Example",
        } satisfies FeedRelease,
      ]);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const services = await openTestServices({
    dataDir: join(context.directory, "integration"),
    endpoints: { ...pluginEndpoints, jev: new URL("/jev", upstream.url).href },
    engine: () => context.engine,
    now: Date.now,
  });
  services.plugins.registerSource({
    description: "Integration source",
    async download({ release, signal }) {
      const response = await fetch(release.downloadUrl, { signal });
      return new Uint8Array(await response.arrayBuffer());
    },
    id: "test.releases",
    name: "Test releases",
    privateDownloads: true,
    async search({ query, signal }) {
      const url = new URL(upstream.url);
      url.searchParams.set("q", query);
      const response = await fetch(url, { signal });
      return (await response.json()) as FeedRelease[];
    },
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => services
  );
  return {
    ...context,
    client: treaty(api),
    async close() {
      control.releaseSearch.resolve();
      control.releaseEvaluation.resolve();
      await services.close();
      upstream.stop(true);
      await context.close();
    },
    control,
    services,
  };
}
