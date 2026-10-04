import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Torrent } from "webtorrent";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("skipping a file preserves the shared pieces needed by the preceding selected file", async () => {
  const context = await fixture(8192, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    await Bun.write(join(source, "second.bin"), context.bytes);
    const seedOptions = { announce: [], pieceLength: 16_384 };
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, seedOptions, resolve)
    );
    const body = new FormData();
    body.set("file", new File([new Uint8Array(seed.torrentFile)], "collection.torrent"));
    body.set("paused", "true");
    const { id } = (await (
      await context.request("/torrents/file", { body, method: "POST" })
    ).json()) as { id: string };
    expect(
      (
        await context.request(`/torrents/${id}/files/1`, {
          ...json({ priority: "skip" }),
          method: "PUT",
        })
      ).status
    ).toBe(200);
    await context.request(`/torrents/${id}/resume`, json({}));
    await context.request(
      `/torrents/${id}/peers`,
      json({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    const detail = await waitFor(
      async () => context.engine.detail(id),
      (value) => value.files[0]?.progress === 1
    );
    expect(detail.files[1]?.priority).toBe("skip");
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array(context.bytes));
  } finally {
    await context.close();
  }
});

test("file access returns a useful error when downloaded data has disappeared", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const detail = await waitFor(
      async () => context.engine.detail(id),
      (value) => value.progress === 1
    );
    await context.request(`/torrents/${id}/pause`, json({}));
    await rm(join(detail.savePath, "source.bin"));
    await Promise.all(
      ["availability", "content"].map(async (endpoint) => {
        const response = await context.request(`/torrents/${id}/files/0/${endpoint}`, undefined);
        expect(response.status).toBe(404);
        expect((await response.json()).error).toContain("is no longer present");
      })
    );
  } finally {
    await context.close();
  }
});

test("a .torrent upload can skip and prioritize a file, and bandwidth settings are applied", async () => {
  const context = await fixture(65_536, []);
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(context.seed.torrentFile)], "source.torrent"));
    form.set("paused", "true");
    const added = await context.request("/torrents/file", { body: form, method: "POST" });
    expect(added.status).toBe(200);
    const { id }: { id: string } = await added.json();
    const read = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    expect((await read()).detail?.files).toHaveLength(1);
    const skip = await context.request(`/torrents/${id}/files/0`, {
      ...json({ priority: "skip" }),
      method: "PUT",
    });
    expect(skip.status).toBe(200);
    await context.request(`/torrents/${id}/resume`, json({}));
    await context.request(
      `/torrents/${id}/peers`,
      json({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    await waitFor(read, (state) => (state.detail?.peers ?? 0) > 0);
    await Bun.sleep(150);
    expect((await read()).detail?.downloaded).toBe(0);
    const high = await context.request(`/torrents/${id}/files/0`, {
      ...json({ priority: "high" }),
      method: "PUT",
    });
    expect(high.status).toBe(200);
    const complete = await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(complete.detail?.files[0]?.priority).toBe("high");
    const setting = { ...(await read()).settings, downloadLimit: 1_048_576, uploadLimit: 524_288 };
    expect((await context.request("/settings", { ...json(setting), method: "PUT" })).status).toBe(
      200
    );
    expect((await read()).settings).toEqual(setting);
  } finally {
    await context.close();
  }
}, 30_000);
