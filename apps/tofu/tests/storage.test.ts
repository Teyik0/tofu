import { expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Torrent } from "webtorrent";
import type { DashboardState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test.skipIf(process.platform === "win32")(
  "POSIX permissions isolate an inaccessible paused destination and recover after access returns",
  async () => {
    const context = await fixture(16_384, []);
    const other = await fixture(16_384, []);
    const protectedDirectory = join(context.directory, "protected");
    try {
      const first = expectSuccess(
        await context.client.torrents.post({
          downloadPath: join(protectedDirectory, "files"),
          paused: false,
          source: context.magnet,
        })
      ) as { id: string };
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
        (detail) => detail.status === "seeding"
      );
      await context.client.torrents({ id: first.id }).pause.post({});
      await chmod(protectedDirectory, 0o000);
      const failed = await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
        (detail) => detail.storageIssue?.kind === "permission-denied"
      );
      expect(failed.status).toBe("paused");
      expect(failed.progress).toBeNull();
      const second = expectSuccess(
        await context.client.torrents.post({ paused: false, source: other.magnet })
      ) as { id: string };
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: second.id }).get()),
        (detail) => detail.status === "seeding"
      );
      expect((await context.client.health.get()).status).toBe(200);
      await chmod(protectedDirectory, 0o700);
      expect((await context.client.torrents({ id: first.id }).repair.post({})).status).toBe(200);
      expect(expectSuccess(await context.client.torrents({ id: first.id }).get()).status).toBe(
        "paused"
      );
      expect(
        expectSuccess(await context.client.torrents({ id: first.id }).get()).storageIssue
      ).toBeNull();
      const content = await context.client
        .torrents({ id: second.id })
        .files({ index: "0" })
        .content.get();
      expect(content.status).toBe(200);
      expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
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
    const first = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
      (detail) => detail.status === "seeding"
    );
    await context.client.torrents({ id: first.id }).pause.post({});
    const alias = join(context.directory, "alias-downloads");
    await symlink(
      join(context.directory, "downloads"),
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const second = expectSuccess(
      await context.client.torrents.post({
        downloadPath: alias,
        paused: false,
        source: other.magnet,
      })
    ) as { id: string };
    const collision = await waitFor(
      async () => expectSuccess(await context.client.torrents({ id: second.id }).get()),
      (detail) => detail.status === "error" || detail.status === "seeding"
    );
    expect(collision.status).toBe("error");
    expect(collision.error).toContain("already used");
    expect(
      (await context.client.torrents({ id: second.id }).delete({ deleteFiles: true })).status
    ).toBe(200);
    const content = await context.client
      .torrents({ id: first.id })
      .files({ index: "0" })
      .content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
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
    const added = await context.client.torrents.post({
      paused: false,
      source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
    });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    const detail = await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
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
    const { id } = expectSuccess(
      await context.client.torrents.post({
        paused: false,
        source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
      })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    await context.client.torrents({ id }).pause.post({});
    const original = join(context.directory, "downloads/collection");
    const outside = join(context.directory, "outside");
    await rename(original, outside);
    await symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(409);
    const move = await context.client
      .destinations({ id: "default" })
      .put({ downloadPath: join(context.directory, "moved"), moveFiles: true, name: "Moved" });
    expect(move.status).toBe(409);
    const removed = await context.client.torrents({ id }).delete({ deleteFiles: true });
    expect(removed.status).toBe(409);
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(1);
    expect(await Bun.file(join(outside, "first.bin")).bytes()).toEqual(
      new Uint8Array(context.bytes)
    );
    expect((await context.client.torrents({ id }).delete({ deleteFiles: false })).status).toBe(200);
    expect(await Bun.file(join(outside, "first.bin")).exists()).toBe(true);
  } finally {
    await context.close();
  }
});
test("filenames starting with two dots can be downloaded, read and explicitly deleted", async () => {
  const context = await fixture(16_384, [], "..source.bin");
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(new Uint8Array(torrentBytes(content))).toEqual(new Uint8Array(context.bytes));
    expect((await context.client.torrents({ id }).delete({ deleteFiles: true })).status).toBe(200);
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
    const { id } = expectSuccess(
      await context.client.torrents.post({
        paused: false,
        source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
      })
    ) as { id: string };
    const completed = await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    await context.client.torrents({ id }).pause.post({});
    const originalPath = completed.savePath;
    const newPath = join(context.directory, "moved-collection");
    const first = join(originalPath, "collection/first.bin");
    const second = join(originalPath, "collection/nested/second.bin");
    const unrelated = join(originalPath, "collection/nested/notes.txt");
    await Bun.write(unrelated, "Keep this file");
    await rm(second);
    const move = () =>
      context.client
        .destinations({ id: "default" })
        .put({ downloadPath: newPath, moveFiles: true, name: "Collection" });
    expect((await move()).status).toBe(404);
    expect(await Bun.file(first).exists()).toBe(true);
    expect(await Bun.file(join(newPath, "collection/first.bin")).exists()).toBe(false);
    expect(expectSuccess(await context.client.torrents({ id }).get()).savePath).toBe(originalPath);
    await Bun.write(second, context.bytes);
    expect((await move()).status).toBe(200);
    expect(expectSuccess(await context.client.torrents({ id }).get()).savePath).toBe(newPath);
    expect(expectSuccess(await context.client.torrents({ id }).get()).status).toBe("paused");
    await Promise.all(
      completed.files.map(async (file) => {
        const response = await context.client
          .torrents({ id })
          .files({ index: file.index })
          .content.get();
        expect(response.status).toBe(200);
        expect(Bun.SHA256.hash(torrentBytes(response), "hex")).toBe(
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
    const body = {
      file: new File([new Uint8Array(seed.torrentFile)], "collection.torrent"),
      paused: "false" as const,
    };
    const response = await context.client.torrents.file.post(body);
    expect(response.status).toBe(200);
    const { id } = expectSuccess(response) as { id: string };
    await context.client
      .torrents({ id })
      .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` });
    const state = await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: id } })
        ) as DashboardState,
      (value) => value.detail?.status === "seeding"
    );
    const destination = join(context.directory, "downloads");
    expect(state.detail?.savePath).toBe(destination); // create-torrent declares files in readdir order, which is unordered on ext4.
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
    const removed = await context.client.torrents({ id }).delete({ deleteFiles: true });
    expect(removed.status).toBe(200);
    expect(await Promise.all(paths.map((path) => Bun.file(path).exists()))).toEqual([false, false]);
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
  } finally {
    await context.close();
  }
});
