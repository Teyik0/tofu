import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Torrent } from "webtorrent";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("relocation keeps a multifile torrent intact on failure and moves only its own nested files", async () => {
  const context = await fixture(16_384, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    await Bun.write(join(source, "nested/second.bin"), context.bytes);
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, { announce: [] }, resolve)
    );
    const { id } = (await (
      await context.request(
        "/torrents",
        json({
          paused: false,
          source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
        })
      )
    ).json()) as { id: string };
    const completed = await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.progress === 1
    );
    await context.request(`/torrents/${id}/pause`, json({}));
    const originalPath = completed.savePath;
    const newPath = join(context.directory, "moved-collection");
    const first = join(originalPath, "collection/first.bin");
    const second = join(originalPath, "collection/nested/second.bin");
    const unrelated = join(originalPath, "collection/nested/notes.txt");
    await Bun.write(unrelated, "Keep this file");
    await rm(second);
    const move = () =>
      context.request("/destinations/default", {
        ...json({ downloadPath: newPath, moveFiles: true, name: "Collection" }),
        method: "PUT",
      });
    expect((await move()).status).toBe(404);
    expect(await Bun.file(first).exists()).toBe(true);
    expect(await Bun.file(join(newPath, "collection/first.bin")).exists()).toBe(false);
    expect(context.engine.detail(id).savePath).toBe(originalPath);
    await Bun.write(second, context.bytes);
    expect((await move()).status).toBe(200);
    expect(context.engine.detail(id).savePath).toBe(newPath);
    expect(context.engine.detail(id).status).toBe("paused");
    await Promise.all(
      completed.files.map(async (file) => {
        const response = await context.request(
          `/torrents/${id}/files/${file.index}/content`,
          undefined
        );
        expect(response.status).toBe(200);
        expect(Bun.SHA256.hash(await response.arrayBuffer(), "hex")).toBe(
          Bun.SHA256.hash(context.bytes, "hex")
        );
        expect(await Bun.file(join(originalPath, file.path)).exists()).toBe(false);
      })
    );
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
    expect(await Bun.file(join(newPath, "collection/nested/notes.txt")).exists()).toBe(false);
  } finally {
    await context.close();
  }
});

test("a multifile torrent keeps its declared folders and deletion preserves unrelated data", async () => {
  const context = await fixture(16_384, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    await Bun.write(join(source, "nested/second.bin"), context.bytes);
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, { announce: [] }, resolve)
    );
    const body = new FormData();
    body.set("file", new File([new Uint8Array(seed.torrentFile)], "collection.torrent"));
    body.set("paused", "false");
    const response = await context.request("/torrents/file", { body, method: "POST" });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    await context.request(
      `/torrents/${id}/peers`,
      json({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    const state = await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${id}`, undefined)
        ).json() as Promise<DashboardState>,
      (value) => value.detail?.progress === 1
    );
    const destination = join(context.directory, "downloads");
    expect(state.detail?.savePath).toBe(destination);
    expect(state.detail?.files.map((file) => file.path)).toEqual([
      "collection/first.bin",
      "collection/nested/second.bin",
    ]);
    const paths = state.detail?.files.map((file) => join(destination, file.path)) ?? [];
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: inspect every file downloaded by the real pair.
      expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(context.bytes, "hex")
      );
    }
    const unrelated = join(destination, "collection/nested/notes.txt");
    await Bun.write(unrelated, "Keep this file");
    const removed = await context.request(`/torrents/${id}`, {
      ...json({ deleteFiles: true }),
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await Promise.all(paths.map((path) => Bun.file(path).exists()))).toEqual([false, false]);
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
  } finally {
    await context.close();
  }
});
