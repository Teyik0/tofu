import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

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
