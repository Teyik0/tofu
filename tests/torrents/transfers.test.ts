import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("a torrent downloads exact bytes from a real peer and exposes its files", async () => {
  await using source = await peer();
  await using app = await application();
  const { client } = await app.start();
  const added = success(await client.torrents.post({ paused: false, source: source.magnet }));
  expect(added.id).toBe(source.id);
  const completed = await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(completed.progress).toBe(1);
  expect(completed.downloaded).toBe(source.bytes.length);
  expect(completed.files).toHaveLength(1);
  expect(completed.files[0]?.name).toBe(source.filename);
  const content = await client.torrents({ id: source.id }).files({ index: "0" }).content.get();
  expectBytes(content, source.bytes);
});

test("pausing stops a transfer and resuming preserves its bytes", async () => {
  await using source = await peer(512 * 1024);
  await using app = await application();
  const { client } = await app.start();
  success(await client.settings.patch({ downloadLimit: 128 * 1024 }));
  success(await client.torrents.post({ paused: false, source: source.magnet }));
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => (torrent.downloaded ?? 0) > 0 && (torrent.progress ?? 1) < 1
  );
  success(await client.torrents({ id: source.id }).pause.post({}));
  const paused = success(await client.torrents({ id: source.id }).get());
  expect(paused.status).toBe("paused");
  expect(paused.peers).toBe(0);
  await Bun.sleep(250);
  const stillPaused = success(await client.torrents({ id: source.id }).get());
  expect(stillPaused.downloaded).toBe(paused.downloaded);
  success(await client.torrents({ id: source.id }).resume.post({}));
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
});

test("invalid sources and duplicate torrents leave the library unchanged", async () => {
  await using source = await peer();
  await using app = await application();
  const { client } = await app.start();
  const invalid = await client.torrents.post({ paused: true, source: "invalid-torrent-source" });
  expect(invalid.status).toBe(400);
  expect(invalid.error?.value).toMatchObject({ detail: expect.any(String) });
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  success(await client.torrents.post({ paused: true, source: source.magnet }));
  const duplicate = await client.torrents.post({ paused: true, source: source.magnet });
  expect(duplicate.status).toBe(409);
  expect(duplicate.error?.value).toMatchObject({ detail: expect.any(String) });
  const library = success(await client.state.get());
  expect(library.torrents).toHaveLength(1);
  expect(library.torrents[0]?.id).toBe(source.id);
});
