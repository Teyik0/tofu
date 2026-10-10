import { expect, test } from "bun:test";
import { join } from "node:path";
import { furin } from "@teyik0/furin";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AniListState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

function collection(title: string) {
  return {
    data: {
      MediaListCollection: {
        hasNextChunk: false,
        lists: [
          {
            entries: [
              {
                media: { id: 10, synonyms: [], title: { romaji: title } },
                progress: 0,
                status: "CURRENT",
              },
            ],
          },
        ],
      },
    },
  };
}

test("AniList renders and navigates a large cached library without overflowing route frames", async () => {
  let requests = 0;
  const entries = Array.from({ length: 500 }, (_, index) => ({
    media: {
      genres: ["Action", "Adventure", "Fantasy"],
      id: index + 1,
      startDate: { day: 1, month: 4, year: 2026 },
      studios: { nodes: [{ name: `Studio ${index}` }] },
      synonyms: [`English title ${index}`, `Alternative title ${index}`],
      tags: Array.from({ length: 20 }, (_value, tag) => ({
        isAdult: false,
        name: `Library tag ${index}-${tag}`,
        rank: 80,
      })),
      title: { romaji: `Cached anime ${index}` },
    },
    progress: 0,
    status: "CURRENT",
  }));
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries }] } } }
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const ready = Promise.withResolvers<string>();
  const host = Bun.spawn([process.execPath, "tests/anilist-page-host.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TOFU_TEST_ANILIST_ENDPOINT: upstream.url.toString() },
    ipc(message: unknown) {
      if (
        message &&
        typeof message === "object" &&
        "url" in message &&
        typeof message.url === "string"
      ) {
        ready.resolve(message.url);
      }
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  const stderr = new Response(host.stderr).text();
  void host.exited.then(async (code) => {
    ready.reject(new Error(`The page server exited with code ${code}: ${await stderr}`));
  });
  try {
    const origin = await ready.promise;
    const configured = await fetch(new URL("/api/plugins/anilist", origin), {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    expect(configured.headers.get("x-furin-revalidate")?.split(",")).toContain("/anilist");
    const loaded = await fetch(new URL("/api/anilist/list", origin), json({}));
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("x-furin-revalidate")?.split(",")).toContain("/anilist");
    expect(((await loaded.json()) as AniListState).entries).toHaveLength(500);
    const navigation = await fetch(new URL("/_furin/data?path=/anilist", origin));
    expect(navigation.status).toBe(200);
    const payload = await navigation.text();
    expect(payload).toContain("Cached anime 499");
    expect(payload).not.toContain("__furinError");
    const page = await fetch(new URL("/anilist", origin));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Cached anime 499");
    expect(requests).toBe(2);
  } finally {
    host.kill("SIGTERM");
    await host.exited;
    upstream.stop(true);
  }
});

test("AniList restores its cached list after restart without contacting upstream", async () => {
  const context = await fixture(4096, []);
  let requests = 0;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection("Cached anime")
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
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
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "private-token", enabled: true }),
      method: "PUT",
    });
    const loaded = await request("/anilist/list", json({}));
    expect(loaded.status).toBe(200);
    expect(requests).toBe(2);
    await service.close();
    service = await AutomationService.open(options);
    api = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    const restored = await request("/anilist", undefined);
    const state = (await restored.json()) as AniListState;
    expect(state.entries[0]?.title).toBe("Cached anime");
    expect(state.connectedUser).toBe("ExampleUser");
    expect(requests).toBe(2);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("AniList serves fresh cache and shares concurrent refreshes", async () => {
  const context = await fixture(4096, []);
  let requests = 0;
  let now = 1_000_000;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      await Bun.sleep(30);
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection(`Anime ${now}`)
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
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
    now: () => now,
  });
  const api = await createTestApi(
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
    const concurrent = await Promise.all([
      request("/anilist/list", json({})),
      request("/anilist/list", json({})),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    expect(requests).toBe(2);
    const fresh = await request("/anilist/refresh", json({}));
    expect(fresh.status).toBe(200);
    expect(requests).toBe(2);
    now += 5 * 60_000 + 1;
    const refreshed = await Promise.all([
      request("/anilist/refresh", json({})),
      request("/anilist/refresh", json({})),
    ]);
    expect(requests).toBe(4);
    const [first] = refreshed;
    if (!first) {
      throw new Error("The refresh response is missing");
    }
    expect((await first.json()).entries[0].title).toBe(`Anime ${now}`);
    await request("/anilist/list", json({}));
    expect(requests).toBe(6);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("AniList returns stale entries immediately, refreshes after the response and keeps them offline", async () => {
  const context = await fixture(4096, []);
  let now = 1_000_000;
  let offline = false;
  let requests = 0;
  let release!: () => void;
  let gate: Promise<void> | null = null;
  const upstream = Bun.serve({
    async fetch(incoming) {
      requests += 1;
      if (gate) {
        await gate;
      }
      if (offline) {
        return new Response("Unavailable", { status: 503 });
      }
      const body = (await incoming.json()) as { query: string };
      return Response.json(
        body.query.includes("Viewer")
          ? { data: { Viewer: { id: 42, name: "ExampleUser" } } }
          : collection(`Anime ${now}`)
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const endpoint = `http://127.0.0.1:${upstream.port}`;
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
    now: () => now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  api.use(await furin({ pagesDir: "./src/pages", sync: context.sync.options }));
  try {
    await request("/plugins/anilist", {
      ...json({ apiKey: "token", enabled: true }),
      method: "PUT",
    });
    await request("/anilist/list", json({}));
    now += 5 * 60_000 + 1;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cached = await request("/anilist", undefined);
    expect((await cached.json()).entries[0].title).toBe("Anime 1000000");
    await Bun.sleep(50);
    expect(requests).toBe(3);
    const pending = request("/anilist/refresh", json({}));
    try {
      const page = await api.handle(new Request("http://localhost/anilist"));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Anime 1000000");
      let refreshed = false;
      const refresh = pending.then(async (response) => {
        refreshed = true;
        return (await response.json()) as AniListState;
      });
      await Bun.sleep(20);
      expect(refreshed).toBe(false);
      release();
      gate = null;
      expect((await refresh)?.entries[0]?.title).toBe(`Anime ${now}`);
    } finally {
      release();
    }
    expect(service.anilist.snapshot().entries[0]?.title).toBe(`Anime ${now}`);
    now += 5 * 60_000 + 1;
    offline = true;
    const failed = await request("/anilist/list", json({}));
    expect(failed.status).toBe(502);
    const state = (await (await request("/anilist", undefined)).json()) as AniListState;
    expect(state.entries[0]?.title).toBe("Anime 1300001");
    expect(state.refreshError).toContain("503");
    expect(state.refreshing).toBe(false);
    const count = requests;
    await request("/anilist/refresh", json({}));
    expect(requests).toBe(count);
    await request("/plugins/anilist", {
      ...json({ apiKey: "another-account", enabled: true }),
      method: "PUT",
    });
    const switched = await request("/anilist", undefined);
    expect((await switched.json()).entries).toEqual([]);
  } finally {
    release?.();
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
