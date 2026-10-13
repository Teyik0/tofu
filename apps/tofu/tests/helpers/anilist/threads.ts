import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { createTestApi } from "../application";
import { openTestServices } from "../services";
import { fixture } from "../torrent";
export async function threadFixture() {
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
        `<rss><channel><item><title>One Piece - 01 VOSTFR 1080p x264</title><guid>21</guid><link>https://nyaa.si/view/21</link><enclosure url="${context.magnet.replaceAll("&", "&amp;")}"/><nyaa:infoHash>${context.seed.infoHash}</nyaa:infoHash></item></channel></rss>`
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
  await client.plugins({ id: "nyaa" }).put({ enabled: true });
  await client.anilist.list.post({});
  await client.anilist.selection.put({ enabled: true, mediaIds: [21, 10] });
  const testContext = {
    ...context,
    client: treaty(api).api,
    async close() {
      await api.application.close();
      upstream.stop(true);
      await context.close();
    },
    async restart() {
      await api.application.close();
      service = await openTestServices(options);
      api = await createTestApi(
        () => context.engine,
        context.sync.options,
        () => service
      );
      client = treaty(api).api;
      testContext.client = treaty(api).api;
    },
  };
  return testContext;
}
