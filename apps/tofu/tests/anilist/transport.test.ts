import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { createTestApi } from "../helpers/application";
import { expectProblem, expectSuccess } from "../helpers/problem";
import { openTestServices } from "../helpers/services";
import { fixture } from "../helpers/torrent";

test.each(["invalid JSON", "network failure"])(
  "AniList catalog reports a controlled upstream error for %s",
  async (failure) => {
    const context = await fixture(1024, []);
    const provider = Bun.serve({
      fetch: () => new Response('{"data":', { headers: { "content-type": "application/json" } }),
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = provider.url.origin;
    if (failure === "network failure") {
      provider.stop(true);
    }
    const service = await openTestServices({
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
    });
    const api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    const client = treaty(api).api;
    try {
      const response = await client.anilist.catalog.post({});
      expect(response.status).toBe(502);
      await expectProblem(response, 502, "AniList unavailable");
    } finally {
      await api.application.close();
      provider.stop(true);
      await context.close();
    }
  }
); // Bun 1.4.3 can crash on Windows after aborting a request to a blocked local server.
// Re-enable these cancellation cases on Windows once the runtime bug is fixed.
test("AniList catalog handles nullable schema fields without inventing metadata", async () => {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    fetch() {
      return Response.json({
        data: {
          Page: {
            media: [
              null,
              {
                externalLinks: [null],
                genres: [null, "Drama"],
                id: 7,
                studios: { nodes: [null, { name: null }] },
                synonyms: [null],
                tags: [null],
                title: null,
              },
            ],
            pageInfo: { currentPage: 1, hasNextPage: false },
          },
        },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = provider.url.origin;
  const service = await openTestServices({
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
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    const response = await client.anilist.catalog.post({});
    expect(response.status).toBe(200);
    expect(expectSuccess(response)).toMatchObject({
      media: [
        {
          averageScore: null,
          coverColor: null,
          episodes: null,
          genres: ["Drama"],
          mediaId: 7,
          studios: [],
          tags: [],
          title: "Anime 7",
        },
      ],
    });
  } finally {
    await api.application.close();
    provider.stop(true);
    await context.close();
  }
});
test.each([200, 429])(
  "AniList upstream errors at HTTP %s stay sanitized and public catalog requests remain anonymous",
  async (status) => {
    const context = await fixture(1024, []);
    const authorizations: (string | null)[] = [];
    const provider = Bun.serve({
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json(
          {
            data: { Page: { media: [], pageInfo: { currentPage: 1, hasNextPage: false } } },
            errors: [{ message: "Sensitive upstream diagnostics: private-test-token" }],
          },
          { status }
        );
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = provider.url.origin;
    const service = await openTestServices({
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
    });
    const api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    const client = treaty(api).api;
    try {
      const configured = await client
        .plugins({ id: "anilist" })
        .put({ apiKey: "private-test-token", enabled: false });
      expect(configured.status).toBe(200);
      const response = await client.anilist.catalog.post({});
      expect(response.status).toBe(502);
      const result = JSON.stringify(response.error?.value ?? response.data);
      expect(result).not.toContain("private-test-token");
      expect(result).toContain(status === 200 ? "account or list inaccessible" : "HTTP 429");
      expect(authorizations).toEqual([null]);
    } finally {
      await api.application.close();
      provider.stop(true);
      await context.close();
    }
  }
);
test.skipIf(process.platform === "win32")(
  "closing the application aborts an in-flight generated SDK request",
  async () => {
    const context = await fixture(1024, []);
    const arrived = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<Response>();
    const provider = Bun.serve({
      fetch() {
        arrived.resolve();
        return blocked.promise;
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = provider.url.origin;
    const service = await openTestServices({
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
    });
    const api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    const client = treaty(api).api;
    try {
      const pending = client.anilist.catalog.post({});
      await arrived.promise;
      await api.application.close();
      const response = await Promise.race([pending, Bun.sleep(1000).then(() => null)]);
      expect(response?.response.ok).toBe(false);
    } finally {
      blocked.resolve(Response.json({ data: null }));
      await api.application.close();
      provider.stop(true);
      await context.close();
    }
  }
);
test("AniList skips unknown episode progress while refreshing and persisting usable entries", async () => {
  const context = await fixture(1024, []);
  let progress: number | null = 2;
  const provider = Bun.serve({
    async fetch(incoming) {
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
                        media: { id: 7, title: { romaji: "Example" } },
                        progress,
                        status: "CURRENT",
                      },
                      {
                        media: { id: 8, title: { romaji: "Usable entry" } },
                        progress: 3,
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
  const endpoint = provider.url.origin;
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
  let service = await openTestServices(options);
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  let client = treaty(api).api;
  try {
    const configured = await client
      .plugins({ id: "anilist" })
      .put({ apiKey: "token", enabled: true });
    expect(configured.status).toBe(200);
    const loaded = await client.anilist.list.post({});
    expect(loaded.status).toBe(200);
    expect(expectSuccess(loaded).entries).toMatchObject([
      { mediaId: 7, progress: 2, title: "Example" },
      { mediaId: 8, progress: 3, title: "Usable entry" },
    ]);
    progress = null;
    const refreshed = await client.anilist.list.post({});
    expect(refreshed.status).toBe(200);
    expect(expectSuccess(refreshed).entries).toMatchObject([{ mediaId: 8, progress: 3 }]);
    await api.application.close();
    service = await openTestServices(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    client = treaty(api).api;
    const cached = await client.anilist.get();
    expect(expectSuccess(cached).entries).toMatchObject([{ mediaId: 8, progress: 3 }]);
  } finally {
    await api.application.close();
    provider.stop(true);
    await context.close();
  }
});
