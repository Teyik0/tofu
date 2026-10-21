import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("removal preserves data unless explicitly requested and never deletes unrelated files", async () => {
  await using source = await peer();
  await using app = await application();
  const { client } = await app.start();
  success(await client.torrents.post({ paused: false, source: source.magnet }));
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  const path = join(app.downloadPath, source.filename);
  const unrelated = join(app.downloadPath, "notes.txt");
  await Bun.write(unrelated, "Keep this file");
  success(await client.torrents({ id: source.id }).delete({ deleteFiles: false }));
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  expect(new Uint8Array(await Bun.file(path).bytes())).toEqual(new Uint8Array(source.bytes));
  success(await client.torrents.post({ paused: false, source: source.magnet }));
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  success(await client.torrents({ id: source.id }).delete({ deleteFiles: true }));
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(unrelated).text()).toBe("Keep this file");
});
