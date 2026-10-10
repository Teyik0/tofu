import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { episodeParamsSchema } from "../src/api/modules/anilist/model";
import { pluginConfigurationSchema } from "../src/api/modules/plugins/model";
import { uploadTorrentSchema } from "../src/api/modules/torrents/model";

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
