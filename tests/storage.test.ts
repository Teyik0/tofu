import { expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Torrent } from "webtorrent";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test.skipIf(process.platform === "win32")(
  "POSIX permissions report an inaccessible paused destination and recover after access returns",
  async () => {
    const context = await fixture(16_384, []);
    const other = await fixture(16_384, []);
    const protectedDirectory = join(context.directory, "protected");
    try {
      const first = (await (
        await context.request(
          "/torrents",
          json({
            downloadPath: join(protectedDirectory, "files"),
            paused: false,
            source: context.magnet,
          })
        )
      ).json()) as { id: string };
      await waitFor(
        async () => context.engine.detail(first.id),
        (detail) => detail.status === "seeding"
      );
      await context.request(`/torrents/${first.id}/pause`, json({}));
      await chmod(protectedDirectory, 0o000);
      const second = (await (
        await context.request("/torrents", json({ paused: false, source: other.magnet }))
      ).json()) as { id: string };
      const failed = await waitFor(
        async () => context.engine.detail(second.id),
        (detail) => detail.status === "error" || detail.status === "checking"
      );
      expect(failed.status).toBe("error");
      expect(failed.error).toContain("EACCES");
      expect((await context.request("/health", undefined)).status).toBe(200);
      await chmod(protectedDirectory, 0o700);
      await context.request(`/torrents/${second.id}/resume`, json({}));
      await waitFor(
        async () => context.engine.detail(second.id),
        (detail) => detail.status === "seeding"
      );
      const content = await context.request(`/torrents/${second.id}/files/0/content`, undefined);
      expect(content.status).toBe(200);
      expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(other.bytes, "hex")
      );
    } finally {
      await chmod(protectedDirectory, 0o700);
      await Promise.all([context.close(), other.close()]);
    }
  }
);

test("symbolic aliases of a destination cannot overwrite or delete another torrent's files", async () => {
  const context = await fixture(16_384, []);
  const other = await fixture(16_384, []);
  try {
    const first = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.detail(first.id),
      (detail) => detail.status === "seeding"
    );
    await context.request(`/torrents/${first.id}/pause`, json({}));
    const alias = join(context.directory, "alias-downloads");
    await symlink(
      join(context.directory, "downloads"),
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const second = (await (
      await context.request(
        "/torrents",
        json({ downloadPath: alias, paused: false, source: other.magnet })
      )
    ).json()) as { id: string };
    const collision = await waitFor(
      async () => context.engine.detail(second.id),
      (detail) => detail.status === "error" || detail.status === "seeding"
    );
    expect(collision.status).toBe("error");
    expect(collision.error).toContain("already used");
    expect(
      (
        await context.request(`/torrents/${second.id}`, {
          ...json({ deleteFiles: true }),
          method: "DELETE",
        })
      ).status
    ).toBe(200);
    const content = await context.request(`/torrents/${first.id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await Promise.all([context.close(), other.close()]);
  }
});

test("a torrent refuses symbolic links below its destination before writing downloaded bytes", async () => {
  const context = await fixture(16_384, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, { announce: [] }, resolve)
    );
    const outside = join(context.directory, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(context.directory, "downloads/collection"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const added = await context.request(
      "/torrents",
      json({
        paused: false,
        source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
      })
    );
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    const detail = await waitFor(
      async () => context.engine.detail(id),
      (value) => value.status === "error" || value.status === "seeding"
    );
    expect(detail.status).toBe("error");
    expect(detail.error).toContain("symbolic link");
    expect(await Bun.file(join(outside, "first.bin")).exists()).toBe(false);
  } finally {
    await context.close();
  }
});

test("file reads, moves and deletion reject a directory replaced by a symbolic link", async () => {
  const context = await fixture(16_384, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
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
    await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    await context.request(`/torrents/${id}/pause`, json({}));
    const original = join(context.directory, "downloads/collection");
    const outside = join(context.directory, "outside");
    await rename(original, outside);
    await symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(409);
    const move = await context.request("/destinations/default", {
      ...json({ downloadPath: join(context.directory, "moved"), moveFiles: true, name: "Moved" }),
      method: "PUT",
    });
    expect(move.status).toBe(409);
    const removed = await context.request(`/torrents/${id}`, {
      ...json({ deleteFiles: true }),
      method: "DELETE",
    });
    expect(removed.status).toBe(409);
    expect(context.engine.snapshot(null).torrents).toHaveLength(1);
    expect(await Bun.file(join(outside, "first.bin")).bytes()).toEqual(
      new Uint8Array(context.bytes)
    );
    expect(
      (
        await context.request(`/torrents/${id}`, {
          ...json({ deleteFiles: false }),
          method: "DELETE",
        })
      ).status
    ).toBe(200);
    expect(await Bun.file(join(outside, "first.bin")).exists()).toBe(true);
  } finally {
    await context.close();
  }
});

test("filenames starting with two dots can be downloaded, read and explicitly deleted", async () => {
  const context = await fixture(16_384, [], "..source.bin");
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array(context.bytes));
    expect(
      (
        await context.request(`/torrents/${id}`, {
          ...json({ deleteFiles: true }),
          method: "DELETE",
        })
      ).status
    ).toBe(200);
    expect(await Bun.file(join(context.directory, "downloads/..source.bin")).exists()).toBe(false);
  } finally {
    await context.close();
  }
});

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
      (detail) => detail.status === "seeding"
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
      (value) => value.detail?.status === "seeding"
    );
    const destination = join(context.directory, "downloads");
    expect(state.detail?.savePath).toBe(destination);
    // create-torrent declares files in readdir order, which is unordered on ext4.
    expect(state.detail?.files.map((file) => file.path).toSorted()).toEqual([
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
