import { expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationService } from "../src/api/modules/automation/service";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

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
    now: Date.now,
  });
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  try {
    const response = await api.handle(
      new Request("http://localhost/api/anilist/catalog", json({}))
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      media: [
        {
          averageScore: null,
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
    await service.close();
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
      now: Date.now,
    });
    const api = createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    try {
      const configured = await api.handle(
        new Request("http://localhost/api/plugins/anilist", {
          ...json({ apiKey: "private-test-token", enabled: false }),
          method: "PUT",
        })
      );
      expect(configured.status).toBe(200);
      const response = await api.handle(
        new Request("http://localhost/api/anilist/catalog", json({}))
      );
      expect(response.status).toBe(502);
      const result = await response.text();
      expect(result).not.toContain("private-test-token");
      expect(result).toContain(status === 200 ? "account or list inaccessible" : "HTTP 429");
      expect(authorizations).toEqual([null]);
    } finally {
      await service.close();
      provider.stop(true);
      await context.close();
    }
  }
);

test("closing the service aborts an in-flight generated SDK request", async () => {
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
    now: Date.now,
  });
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  try {
    const pending = api.handle(new Request("http://localhost/api/anilist/catalog", json({})));
    await arrived.promise;
    await service.close();
    const response = await Promise.race([pending, Bun.sleep(1000).then(() => null)]);
    expect(response?.ok).toBe(false);
  } finally {
    blocked.resolve(Response.json({ data: null }));
    await service.close();
    provider.stop(true);
    await context.close();
  }
});

test("nullable AniList episode progress never replaces a valid persisted library with zero", async () => {
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
  let service = await AutomationService.open(options);
  const api = createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const configured = await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    const loaded = await request("/anilist/list", json({}));
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).entries).toMatchObject([
      { mediaId: 7, progress: 2, title: "Example" },
    ]);
    progress = null;
    const failed = await request("/anilist/list", json({}));
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("did not return episode progress");
    await service.close();
    service = await AutomationService.open(options);
    const cached = await request("/anilist", undefined);
    expect((await cached.json()).entries).toMatchObject([{ mediaId: 7, progress: 2 }]);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});
