import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { AniListClient } from "../../../src/types";
import { createTestApi } from "../application";
import { openTestServices } from "../services";
import { fixture } from "../torrent";
export async function oauthFixture(client?: AniListClient) {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as { query: string };
      if (incoming.headers.get("authorization") !== "Bearer account-token") {
        return Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
      }
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
                        progress: 1,
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
  const reserved = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
  const callback = `http://127.0.0.1:${reserved.port}/callback`;
  reserved.stop(true);
  const base = `http://127.0.0.1:${provider.port}`;
  const options = {
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service,
    client
  );
  const testContext = {
    callback,
    client: treaty(api).api,
    async close() {
      await api.application.close();
      provider.stop(true);
      await context.close();
    },
    async restart() {
      await api.application.close();
      service = await openTestServices(options);
      api = await createTestApi(
        () => context.engine,
        context.sync.options,
        () => service,
        client
      );
      testContext.client = treaty(api).api;
    },
  };
  return testContext;
}
