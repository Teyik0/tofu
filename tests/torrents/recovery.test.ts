import { expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { changeStorageDevice } from "../helpers/storage";

test("a stale torrent cannot block a destination validated by another torrent", async () => {
  await using source = await peer(undefined, "Original.mkv");
  await using current = await peer(undefined, "Current.mkv");
  await using added = await peer(undefined, "New.mkv");
  await using app = await application();
  let server = await app.start();
  success(await server.client.torrents.post({ paused: false, source: source.magnet }));
  success(await server.client.torrents.post({ paused: false, source: current.magnet }));
  await Promise.all(
    [source, current].map(async (torrent) => {
      await waitFor(
        async () => success(await server.client.torrents({ id: torrent.id }).get()),
        (detail) => detail.status === "seeding"
      );
    })
  );
  await server.stop();
  changeStorageDevice(join(app.directory, "state", "tofu.sqlite"), source.id);
  server = await app.start();
  expect(success(await server.client.torrents({ id: source.id }).get()).storageIssue?.kind).toBe(
    "no-space"
  );
  success(await server.client.torrents.post({ paused: false, source: added.magnet }));
  await waitFor(
    async () => success(await server.client.torrents({ id: added.id }).get()),
    (detail) => detail.status === "seeding"
  );
  expect(await Bun.file(join(app.downloadPath, added.filename)).bytes()).toEqual(
    new Uint8Array(added.bytes)
  );

  success(await server.client.torrents({ id: added.id }).delete({ deleteFiles: false }));
  // Windows requires closing the remaining torrent file before renaming its parent directory.
  success(await server.client.torrents({ id: current.id }).pause.post({}));
  const originalPath = join(app.directory, "original-downloads");
  await rename(app.downloadPath, originalPath);
  await mkdir(app.downloadPath);
  const rejected = await server.client.torrents.post({ paused: true, source: added.magnet });
  expect(rejected.status).toBe(409);
  expect(await Bun.file(join(app.downloadPath, added.filename)).exists()).toBe(false);
  expect(await Bun.file(join(originalPath, source.filename)).bytes()).toEqual(
    new Uint8Array(source.bytes)
  );
}, 60_000);

test("a file deleted on disk remains missing after restart until the torrent is repaired", async () => {
  await using source = await peer();
  await using app = await application();
  let server = await app.start();
  success(await server.client.torrents.post({ paused: false, source: source.magnet }));
  await waitFor(
    async () => success(await server.client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  const path = join(app.downloadPath, source.filename);
  await rm(path);
  success(await server.client.torrents({ id: source.id }).verify.post({}));
  const missing = success(await server.client.torrents({ id: source.id }).get());
  expect(missing.status).toBe("error");
  expect(missing.storageIssue?.kind).toBe("missing-files");
  expect(missing.progress).toBe(0);
  expect(success(await server.client.state.get()).torrents).toHaveLength(1);
  expect(await Bun.file(path).exists()).toBe(false);

  await server.stop();
  server = await app.start();
  const restored = success(await server.client.torrents({ id: source.id }).get());
  expect(restored.storageIssue?.kind).toBe("missing-files");
  expect(restored.status).toBe("error");
  expect((await server.client.torrents({ id: source.id }).resume.post({})).status).toBe(409);
  expect(await Bun.file(path).exists()).toBe(false);

  success(await server.client.torrents({ id: source.id }).repair.post({}));
  success(await server.client.torrents({ id: source.id }).resume.post({}));
  const repaired = await waitFor(
    async () => success(await server.client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(repaired.storageIssue).toBeNull();
  expect(repaired.progress).toBe(1);
  expect(new Uint8Array(await Bun.file(path).bytes())).toEqual(new Uint8Array(source.bytes));
  expectBytes(
    await server.client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
});
