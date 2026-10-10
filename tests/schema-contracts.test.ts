import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { aniListConfigurationSchema, episodeParamsSchema } from "../src/api/modules/anilist/model";
import { draft } from "../src/api/modules/automation/model";
import { defaultAutomationPreferences } from "../src/api/modules/automation/rules";
import { pluginConfigurationSchema } from "../src/api/modules/plugins/model";
import { createTorrentSchema, uploadTorrentSchema } from "../src/api/modules/torrents/model";

test("AniList configuration validates callback URLs without excluding desktop callbacks", async () => {
  const app = new Elysia().put(
    "/configuration",
    { body: aniListConfigurationSchema },
    ({ body }) => body
  );
  const request = (redirectUri: string) =>
    app.handle(
      new Request("http://localhost/configuration", {
        body: JSON.stringify({ redirectUri, userName: "" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      })
    );
  const invalid = await Promise.all(["", "not a URL", "http://"].map(request));
  expect(invalid.map((response) => response.status)).toEqual([422, 422, 422]);
  const valid = await Promise.all(
    ["tofu://anilist/callback", "http://localhost:3030/api/anilist/callback"].map(request)
  );
  expect(valid.map((response) => response.status)).toEqual([200, 200]);
});

test("episode URLs parse integer identifiers and reject invalid segments", async () => {
  const app = new Elysia().post(
    "/entries/:mediaId/:episode",
    { params: episodeParamsSchema },
    ({ params }) => params
  );
  const valid = await app.handle(new Request("http://localhost/entries/123/4", { method: "POST" }));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ episode: 4, mediaId: 123 });
  const invalid = await Promise.all(
    ["0", "1.5", "10001", "invalid"].map((episode) =>
      app.handle(new Request(`http://localhost/entries/123/${episode}`, { method: "POST" }))
    )
  );
  for (const response of invalid) {
    expect(response.status).toBe(422);
  }
});

test("plugin configuration rejects invalid daily limits", async () => {
  const app = new Elysia().put("/plugin", { body: pluginConfigurationSchema }, ({ body }) => body);
  const request = (body: unknown) =>
    app.handle(
      new Request("http://localhost/plugin", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PUT",
      })
    );
  expect((await request({ dailyLimit: 1000, enabled: true })).status).toBe(200);
  const numericInput = await request({ dailyLimit: "42", enabled: true });
  expect(numericInput.status).toBe(200);
  expect(await numericInput.json()).toEqual({ dailyLimit: 42, enabled: true });
  const invalid = await Promise.all(
    [0, 100_001, 1.5, "invalid", "", " ", "1.0", "1e2", "0x10", true].map((dailyLimit) =>
      request({ dailyLimit, enabled: true })
    )
  );
  for (const response of invalid) {
    expect(response.status).toBe(422);
  }
});

test("torrent uploads accept multipart files and reject files above 8 MiB", async () => {
  const app = new Elysia().post("/upload", { body: uploadTorrentSchema }, ({ body }) => ({
    paused: body.paused,
    size: body.file.size,
  }));
  const request = (size: number) => {
    const body = new FormData();
    body.set("file", new File([new Uint8Array(size)], "sample.torrent"));
    body.set("paused", "false");
    return app.handle(new Request("http://localhost/upload", { body, method: "POST" }));
  };
  const valid = await request(100);
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ paused: "false", size: 100 });
  expect((await request(8 * 1024 * 1024 + 1)).status).toBe(422);
});

test("torrent creation caps tracker lists and tracker URL lengths", async () => {
  const app = new Elysia()
    .post("/create", { body: createTorrentSchema }, () => ({ ok: true }))
    .post("/upload", { body: uploadTorrentSchema }, () => ({ ok: true }));
  const trackers = [
    Array.from({ length: 101 }, () => "udp://tracker.example:80"),
    ["x".repeat(2049)],
  ];
  const invalid = await Promise.all(
    trackers.flatMap((urls) => {
      const form = new FormData();
      form.set("file", new File(["torrent"], "sample.torrent"));
      form.set("paused", "true");
      form.set("trackers", urls.join("\n"));
      return [
        app.handle(
          new Request("http://localhost/create", {
            body: JSON.stringify({
              paused: true,
              source: "magnet:?xt=urn:btih:test",
              trackers: urls,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        ),
        app.handle(new Request("http://localhost/upload", { body: form, method: "POST" })),
      ];
    })
  );
  expect(invalid.map((response) => response.status)).toEqual([422, 422, 422, 422]);
});

test("torrent uploads require an explicit paused boolean string", async () => {
  const app = new Elysia().post(
    "/upload",
    { body: uploadTorrentSchema },
    ({ body }) => body.paused
  );
  const request = (paused: string) => {
    const body = new FormData();
    body.set("file", new File(["torrent"], "sample.torrent"));
    body.set("paused", paused);
    return app.handle(new Request("http://localhost/upload", { body, method: "POST" }));
  };
  const invalid = await Promise.all(["", "yes", "TRUE", "0"].map(request));
  expect(invalid.map((response) => response.status)).toEqual([422, 422, 422, 422]);
  const valid = await Promise.all(["true", "false"].map(request));
  expect(valid.map((response) => response.status)).toEqual([200, 200]);
});

test("pattern drafts share the save and preview title limit", async () => {
  const app = new Elysia().post("/draft", { body: draft }, () => ({ ok: true }));
  const input = {
    ...defaultAutomationPreferences,
    destinationId: "default",
    enabled: true,
    includeExisting: true,
    matchMode: "pattern",
    query: "Example",
    season: null,
    title: "a".repeat(257),
  };
  const request = (body: typeof input) =>
    app.handle(
      new Request("http://localhost/draft", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
  expect((await request(input)).status).toBe(422);
  expect((await request({ ...input, title: "a".repeat(256) })).status).toBe(200);
  expect((await request({ ...input, matchMode: "exact", title: "a".repeat(500) })).status).toBe(
    200
  );
});
